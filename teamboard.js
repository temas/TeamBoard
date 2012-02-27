var express = require("express");
var everyauth = require("everyauth");
var fs = require("fs");
var sqlite = require("sqlite-fts");
var request = require("request");
var sqliteStore = require("./connect-sqlite")(express);
var async = require("async");

var githubAccessToken; // We keep the admin token for doing our primary updates, but we'll use the session token for everything else
var updater;
var githubDb = new sqlite.Database();

// Get our config or default to empty
try {
  var config = JSON.parse(fs.readFileSync("config.json"));
} catch(E) {
  console.error("Error reading config: %s", E);
  var config = {states:[]};
}

function openDb(callback) {
  githubDb.open(config.dbPath, function(error) {
    return callback(error);
  });
}

function GithubUpdater(accessToken) {
  this.updating = false;
  this.lastUpdated = undefined;
  this.accessToken = accessToken;
}
GithubUpdater.prototype.init = function(callback) {
  var self = this;
  openDb(function(error) {
    if (error) return callback(error);
    githubDb.execute("CREATE TABLE IF NOT EXISTS Issues(id INT PRIMARY KEY, json TEXT, lastUpdated TEXT, isProject INT, state TEXT)", function(error) {
      return callback(error);
    });
  });
};
GithubUpdater.prototype.start = function() {
  var self = this;
  if (this.updating) return;
  githubDb.execute(" SELECT lastUpdated FROM Issues ORDER BY lastUpdated DESC LIMIT 1", function(error, rows) {
    if (rows.length > 0) {
      self.lastUpdated = rows[0].lastUpdated;
    }
    console.log("Should start from %s", self.lastUpdated);
    self.pageIssues(0);
  });
};
GithubUpdater.prototype.pageIssues = function(page) {
  var self = this;
  console.log("Processing page %d", page);
  var options = {
    sort:"updated",
    access_token:this.accessToken,
    per_page:100
  };
  if (page > 0) {
    options.page = page;
  }
  if (this.lastUpdated) {
    options.since = this.lastUpdated;
  }
  request.get({url:"https://api.github.com/repos/LockerProject/Locker/issues", qs:options, json:true}, function(error, result, body) {
    if (error) {
      console.log("ERROR getting issues: ");
      console.log(error);
      return;
    }
    // Process all our issues and cache them
    githubDb.prepare("INSERT OR REPLACE INTO Issues VALUES(?, ?, ?, ?, ?)", function(error, statement) {
      async.forEachSeries(body, function(issue, cb) {
        console.log("Processing " + issue.number);
        // Loop over the issues and match any states and cache it
        var isProject = false;
        var state;
        issue.labels.forEach(function(label) {
          if (label.name == config.projectLabel) isProject = true;
          config.states.forEach(function(stateLabel) {
            if (stateLabel.label == label.name) state = stateLabel.label;
          });
        });
        statement.bindArray([issue.number, JSON.stringify(issue), issue.updated_at, isProject ? 1 : 0, state], function() {
          statement.step(function(error, row) {
            statement.reset();
            return cb();
          });
        });
      }, function() {
        // Clean up our statement
        statement.finalize(function(err) {
          // See if we're on the last page and paginate if not
          if (!result.headers.link) result.headers.link = "";
          var lastPage;
          result.headers.link.split(",").forEach(function(link) {
            var matches = link.match(/<.*[&?]page=(\d+).*>;\s+rel="last"/);
            if (matches) lastPage = Number(matches[1]);
          });
          if (lastPage &&  (++page < lastPage)) {
            // Using a nextTick here so we don't explode the stack on long processing
            process.nextTick(function() {
              self.pageIssues(page);
            });
          } else {
            console.log("Done paging issues");
          }
        });
      });
    });
  });
};
function checkGithubUpdater() {
  if (!updater && githubAccessToken) {
    updater = new GithubUpdater(githubAccessToken);
    updater.init(function(err) {
      if (err) {
        console.error("Error starting the GitHub updater: %s", err);
        return;
      }
      updater.start();
    });
  }
}

// Everyauth middleware for our github control
everyauth.debug = true;
everyauth.github
  .moduleTimeout(10000)
  .appId(config.appId)
  .appSecret(config.appSecret)
  .findOrCreateUser(function(session, accessToken, accessTokenExtra, githubUserMetaData) {
    session.githubToken = accessToken;
    if (githubUserMetaData.login == config.runAs) {
      githubAccessToken = accessToken;
      session.admin = true
      process.nextTick(checkGithubUpdater);
    } else {
      session.admin = false;
    }
    return session.githubUser = githubUserMetaData;
  })
  .redirectPath("/");

// Setup our core routes
var app = express.createServer();

// The other middlewares and start it up
app.configure(function() {
  app.use(express.static(__dirname + "/static"));
  app.use(express.bodyParser());
  app.use(express.cookieParser());
  app.use(express.session({
    secret:"fhcregrnzobneqfrpergxrl",
    store:new sqliteStore
  }));
  app.use(everyauth.middleware());
  app.use(function(req, res, next) {
    // Make sure we keep our github access token updated
    if (req.session && req.session.githubUser && req.session.githubUser.login == config.runAs && !githubAccessToken) {
      githubAccessToken = req.session.githubToken;
    }
    next();
  });
});
everyauth.helpExpress(app);

app.get("/", function(req, res) {
  openDb(function(error) {
    async.forEachSeries(config.states, function(state, cb) {
      state.cards = [];
      console.log("Getting cards for state " + state.label);
      githubDb.execute("SELECT * FROM Issues WHERE state=?", [state.label], function(error, rows) {
        console.log(state.label + ":" + rows.length);
        rows.forEach(function(row) {
          var issue = JSON.parse(row.json);
          state.cards.push({title:issue.title, number:issue.number});
        });
        cb();
      });
    }, function() {
      console.dir(config.states);
      res.render("board.ejs", {states:config.states, admin:((req.session && req.session.admin) ? true : false)});
    });
  });
});

app.get("/checkUpdater", function(req, res) {
  if (!req.session.admin) {
    return res.send("Not an admin", 401);
  }
  console.log("Checking the updater");
  checkGithubUpdater();
  res.send("true");
});

app.listen(8326, function() {
  console.log("TeamBoard is listening!");
});
