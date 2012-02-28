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
    async.forEachSeries([
      "CREATE TABLE IF NOT EXISTS Issues(id INT PRIMARY KEY, json TEXT, lastUpdated TEXT, isProject INT, state TEXT)",
      "CREATE TABLE IF NOT EXISTS Comments(id INT PRIMARY KEY, issue_id INT, json TEXT)"
    ], function(query, cb) {
        githubDb.execute(query, cb);
    }, function() {
      callback() 
    });
  });
};
GithubUpdater.prototype.start = function() {
  var self = this;
  if (this.updating) return;
  console.log("Github updater starting.");
  githubDb.execute("SELECT lastUpdated FROM Issues ORDER BY lastUpdated DESC LIMIT 1", function(error, rows) {
    if (rows.length > 0) {
      self.lastUpdated = rows[0].lastUpdated;
    }
    console.log("Should start from %s", self.lastUpdated);
    self.cacheIssues();
  });
};
GithubUpdater.prototype.pageRequest = function(options, eachCb, finalCb) {
  var self = this;
  var page = options.qs.page || 0;
  console.log("Processing page %d", page);
  request(options, function(error, result, body) {
    if (error) {
      console.log("Github paging error: %s", error);
      return finalCb(error);
    }
    // Iterate over them all
    async.forEachSeries(body, eachCb, finalCb);
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
        options.qs.page = page;
        self.pageRequest(options, eachCb, finalCb);
      });
    } else {
      console.log("Done paging issues");
    }
  });
};
GithubUpdater.prototype.cacheComments = function(issueId, cb) {
  var self = this;
  var options = {
    method:"get",
    url:"https://api.github.com/repos/LockerProject/Locker/issues/" + issueId + "/comments",
    qs:{
      page:0,
      sort:"updated",
      access_token:this.accessToken,
      per_page:100
    },
    json:true
  };
  if (this.lastUpdated) {
    options.qs.since = this.lastUpdated;
  }
  githubDb.prepare("INSERT OR REPLACE INTO Comments VALUES(?, ?, ?)", function(error, statement) {
    self.pageRequest(options, function(comment, stepCb) {
      statement.bindArray([comment.id, issueId, JSON.stringify(comment)], function() {
        statement.step(function(error, row) {
          statement.reset();
          stepCb();
        });
      });
    }, function(error) {
      statement.finalize(function() {
        cb();
      });
    });
  });
};
GithubUpdater.prototype.cacheIssues = function(cb) {
  cb = cb || function() { }
  var self = this;
  var options = {
    method:"get",
    url:"https://api.github.com/repos/LockerProject/Locker/issues",
    qs:{
      page:0,
      sort:"updated",
      access_token:this.accessToken,
      per_page:100
    },
    json:true
  };
  if (this.lastUpdated) {
    options.qs.since = this.lastUpdated;
  }
  githubDb.prepare("INSERT OR REPLACE INTO Issues VALUES(?, ?, ?, ?, ?)", function(error, statement) {
    if (error) {
      console.log("ERROR preparing for issues: %s", error);
      return;
    }
    self.pageRequest(options, function(issue, stepCb) {
      // Process all our issues and cache them
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
          self.cacheComments(issue.number, function() {
            statement.reset();
            stepCb();
          });
        });
      });
    }, function() {
      // Clean up our statement
      statement.finalize(cb);
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
    console.log("HERE2");
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
    if (error) {
      console.error(error);
      return res.send(500);
    }
    async.forEachSeries(config.states, function(state, cb) {
      state.cards = [];
      console.log("Getting cards for state " + state.label);
      githubDb.execute("SELECT * FROM Issues WHERE state=?", [state.label], function(error, rows) {
        if (error) {
          console.error(error);
          return res.send(500);
        }
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

app.get("/card/:id", function(req, res) {
  openDb(function(error) {
    if (error) {
      console.error(error);
      return res.send(500);
    }
    githubDb.execute("SELECT * FROM Issues WHERE id=? LIMIT 1", [req.params.id], function(err, rows) {
      if (err || !rows || rows.length == 0) {
        console.log("Invalid card result: %s", err);
        return res.send(500);
      }
      var issue = JSON.parse(rows[0].json);
      githubDb.execute("SELECT* FROM Comments WHERE issue_id=?", [req.params.id], function(err, commentsRows) {
        comments = [];
        commentsRows.forEach(function(commentRow) {
          comments.push(JSON.parse(commentRow.json));
        });
        res.render("cardDetails.ejs", {issue:issue, comments:comments, layout:false});
      });
    });
  });
});

// Move :id to the state :state as an index into config.states
app.get("/move/:id/:state", function(req, res) {
  openDb(function(error) {
    if (error) {
      console.error(error);
      return res.send(500);
    }
    githubDb.execute("SELECT * FROM Issues WHERE id=? LIMIT 1", [req.params.id], function(err, rows) {
      if (err || !rows || rows.length != 1) {
        console.error("Invalid issue for %d", req.params.id);
        return res.send(500);
      }
      request({method:"delete", "url":issue.url + "/labels/" + rows[0].state, json:true}, function(req, res) {
        request({method:"post", "url":issue.url + "/labels", json:[config.states[req.params.state]]}, function(req, res) {
          checkGithubUpdater();
        });
      });
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
