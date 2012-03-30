var express = require("express");
var everyauth = require("everyauth");
var fs = require("fs");
var sqlite = require("sqlite-fts");
var request = require("request");
var sqliteStore = require("./connect-sqlite")(express);
var async = require("async");
var util = require("util");
var crypto = require("crypto");

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
    githubDb.executeScript([
      "CREATE TABLE IF NOT EXISTS Config(key STRING, value STRING)",
      ""
    ].join(";"), function(err) {
      return callback(err);
    });
  });
}

function Github(accessToken) {
  this.updating = false;
  this.lastUpdated = undefined;
  this.accessToken = accessToken;

  this.apiBase = "https://api.github.com";
  //this.apiBase = "http://lvh.me:5555";
}
Github.prototype.init = function(callback) {
  var self = this;
  openDb(function(error) {
    if (error) return callback(error);
    githubDb.executeScript([
      "CREATE TABLE IF NOT EXISTS Issues(id STRING PRIMARY KEY, json TEXT, lastUpdated TEXT, isProject INT, state TEXT)",
      "CREATE TABLE IF NOT EXISTS Comments(id STRING PRIMARY KEY, issue_id STRING, json TEXT)",
      "CREATE TABLE IF NOT EXISTS ProjectTasks(id STRING PRIMARY KEY, project STRING, task STRING, required INT)",
      ""
    ].join(";"), function(error) {
      callback();
    });
  });
};
Github.prototype.start = function() {
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
Github.prototype.getLabels = function(user, repo, cbDone) {
  request({url:this.apiBase + "/repos/" + user + "/" + repo + "/labels", json:true}, function(error, resp, body) {
    cbDone(error ? error : body);
  });
};
// label must be {name:name, color:hexColor}
Github.prototype.createLabel = function(user, repo, label, cbDone) {
  if (label.color[0] == "#") label.color = label.color.slice(1);
  request({method:"post", url:this.apiBase + "/repos/" + user + "/" + repo + "/labels", qs:{access_token:this.accessToken}, json:label}, function(error, resp, body) {
    console.dir(body);
    cbDone(error ? error : "");
  });
};
Github.prototype.createIssue = function(args, cbDone) {
  if (!args.title) {
    return cbDone(new Error("No title was specified"));
  }

  var createArgs = {
    title:args.title
  };
  if (args.description) createArgs.body = args.description;
  if (args.labels) createArgs.labels = args.labels;
  if (args.milestone) createArgs.milestone = args.milestone;
  if (args.assignee) createArgs.assignee = args.assignee;

  console.log("POST TO: " + this.apiBase + "/repos/" + config.trackers[0].project + "/" + config.trackers[0].repos[0] + "/issues");
  request({
    url:this.apiBase + "/repos/" + config.trackers[0].project + "/" + config.trackers[0].repos[0] + "/issues",
    qs:{access_token:args.accessToken},
    method:"post",
    json:createArgs
  }, function(err, resp, body) {
    console.error(err);
    console.log(body);
    console.log("%s", util.inspect(resp, true, 4));
    if (err || resp.statusCode >= 400) return cbDone(err);
    var issue = body;
    // Process all our issues and cache them
    console.log("Processing " + issue.url);
    // Loop over the issues and match any states and cache it
    var isProject = false;
    var state;
    if (!issue.labels) issue.labels = [];
    issue.labels.forEach(function(label) {
      if (label.name == config.projectLabel) isProject = true;
      config.states.forEach(function(stateLabel) {
        if (stateLabel.label == label.name) state = stateLabel.label;
      });
    });
    githubDb.execute("INSERT OR REPLACE INTO Issues VALUES(?, ?, ?, ?, ?)", [crypto.createHash("sha1").update(issue.url).digest("hex"), JSON.stringify(issue), issue.updated_at, isProject ? 1 : 0, state], function() {
      return cbDone();
    });
  });
};
Github.prototype.cacheIssue = function(issueUrl, cbDone) {
  var self = this;
  request({method:"get", url:issueUrl, qs:{access_token:this.accessToken}, json:true}, function(err, resp, body) {
    if (err || resp.statusCode >= 400) return cbDone(err);
    var issue = body;
    // Process all our issues and cache them
    console.log("Processing " + issue.url);
    // Loop over the issues and match any states and cache it
    var isProject = false;
    var state;
    if (!issue.labels) issue.labels = [];
    issue.labels.forEach(function(label) {
      if (label.name == config.projectLabel) isProject = true;
      config.states.forEach(function(stateLabel) {
        if (stateLabel.label == label.name) state = stateLabel.label;
      });
    });
    githubDb.execute("INSERT OR REPLACE INTO Issues VALUES(?, ?, ?, ?, ?)", [crypto.createHash("sha1").update(issue.url).digest("hex"), JSON.stringify(issue), issue.updated_at, isProject ? 1 : 0, state], function() {
      self.cacheComments(issue, cbDone);
    });
  });
};
Github.prototype.pageRequest = function(options, eachCb, finalCb) {
  var self = this;
  var page = options.qs.page || 0;
  if (options.qs.page) console.log("Processing page %d", page);
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
    if (lastPage &&  (++page <= lastPage)) {
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
var urlRegex = /^(?:(.*)\/(.*))?#(\d+)$/;
Github.prototype.getCommentURL = function(arg, user, repo) {
  var matches = arg.match(urlRegex);
  if (matches) {
    return "https://api.github.com/repos/" + (matches[1] ? matches[1] : user) + "/" + (matches[2] ? matches[2] : repo) + "/issues/" + matches[3];
  }
  return undefined;
};
var tbRE = /TB-(.*)\((.*)\)/;
Github.prototype.cacheComments = function(issue, cb) {
  var self = this;
  var options = {
    method:"get",
    url:this.apiBase + "/repos/" + config.trackers[0].project + "/" + config.trackers[0].repos[0] + "/issues/" + issue.number + "/comments",
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
  var issueId = crypto.createHash("sha1").update(issue.url).digest("hex");
  self.pageRequest(options, function(comment, stepCb) {
    var matches = comment.body.match(tbRE);
    if (!matches) matches = [];
    var i = 1;
    async.whilst(
      function() { return i < matches.length; },
      function(forCb) {
        var action = matches[i].toUpperCase();
        var url = self.getCommentURL(matches[i + i], config.trackers[0].project, config.trackers[0].repos[0]);
        console.log("Got match: " + action + " - " + url);
        if (!url) {
          i += 2;
          return forCb();
        }
        var id = crypto.createHash("sha1").update(url).digest("hex");
        var required = 0;

        if (action == "REQUIRE") {
          required = 1;
        }
        i += 2;
        githubDb.execute(
          "INSERT OR REPLACE INTO ProjectTasks VALUES(?, ?, ?, ?)",
          [crypto.createHash("sha1").update(issueId).update(id).digest("hex"),
           issueId, id, required],
          forCb);
      },
      function(err) {
        githubDb.execute("INSERT OR REPLACE INTO Comments VALUES(?, ?, ?)",
          [issueId + "/" + comment.id, issueId, JSON.stringify(comment)],
          stepCb
        );
      }
    );
  }, cb);
};
Github.prototype.cacheIssues = function(cb) {
  cb = cb || function() { };
  var self = this;
  var options = {
    method:"get",
    url:this.apiBase + "/repos/" + config.trackers[0].project + "/" + config.trackers[0].repos[0] + "/issues",
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
  self.pageRequest(options, function(issue, stepCb) {
    if (!issue) return process.nextTick(stepCb);
    // Process all our issues and cache them
    console.log("Processing " + issue.url);
    // Loop over the issues and match any states and cache it
    var isProject = false;
    var state;
    if (!issue.labels) issue.labels = [];
    issue.labels.forEach(function(label) {
      if (label.name == config.projectLabel) isProject = true;
      config.states.forEach(function(stateLabel) {
        if (stateLabel.label == label.name) state = stateLabel.label;
      });
    });
    githubDb.execute("INSERT OR REPLACE INTO Issues VALUES(?, ?, ?, ?, ?)", [
        crypto.createHash("sha1").update(issue.url).digest("hex"),
        JSON.stringify(issue), issue.updated_at, isProject ? 1 : 0, state
      ], function(error, rows) {
        self.cacheComments(issue, stepCb);
      }
    );
  }, cb);
};
function checkGithub(cbDone) {
  if (!updater) {
    if (!config.accessToken || config.accessToken.length === 0) {
      return cbDone(new Error("No valid access token found"));
    }
    updater = new Github(config.accessToken);
    updater.init(function(err) {
      if (err) {
        console.error("Error starting the GitHub updater: %s", err);
        return;
      }
      updater.start();
      cbDone();
    });
  }
}

// Everyauth middleware for our github control
everyauth.debug = true;
everyauth.github
  .moduleTimeout(10000)
  .scope("repo")
  .appId(config.appId)
  .appSecret(config.appSecret)
  .findOrCreateUser(function(session, accessToken, accessTokenExtra, githubUserMetaData) {
    console.log("%j", githubUserMetaData);
    session.githubToken = accessToken;
    if (githubUserMetaData.login == config.runAs) {
      session.admin = true;
      //process.nextTick(checkGithub);
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
    store:new sqliteStore()
  }));
  app.use(everyauth.middleware());
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
      //console.log("Getting cards for state " + state.label);
      githubDb.execute("SELECT * FROM Issues WHERE state=?", [state.label], function(error, rows) {
        if (error) {
          return cb();
        }
        //console.log(state.label + ":" + rows.length);
        rows.forEach(function(row) {
          var issue = JSON.parse(row.json);
          var card = {title:issue.title, id:row.id, number:issue.number, tasks:[]};
          githubDb.execute("SELECT * FROM ProjectTasks pt LEFT JOIN Issues i ON pt.task = i.id WHERE pt.project = ?", [row.id], function(taskError, taskRows) {
            taskRows.forEach(function(taskRow) {
              var task = JSON.parse(taskRow.json);
              card.tasks.push({title:task.title, id:taskRow.id, number:task.number, tasks:[]});
            });
            state.cards.push(card);
          });
        });
        cb();
      });
    }, function() {
      console.log(util.inspect(config.states, false, 8));
      res.render("board.ejs", {states:config.states, admin:((req.session && req.session.admin) ? true : false)});
    });
  });
});

app.get("/card/:id", function(req, res) {
  console.log("Request for " + req.params.id);
  openDb(function(error) {
    if (error) {
      console.error(error);
      return res.send(500);
    }
    githubDb.execute("SELECT * FROM Issues WHERE id=? LIMIT 1", [req.params.id], function(err, rows) {
      if (err || !rows || rows.length === 0) {
        console.log("Invalid card result: %s", err);
        return res.send(500);
      }
      var issue = JSON.parse(rows[0].json);
      var card = {issue:issue, layout:false, comments:[], tasks:[]};
      githubDb.execute("SELECT* FROM Comments WHERE issue_id=?", [req.params.id], function(err, commentsRows) {
        commentsRows.forEach(function(commentRow) {
          card.comments.push(JSON.parse(commentRow.json));
        });
          githubDb.execute("SELECT * FROM ProjectTasks pt LEFT JOIN Issues i ON pt.task = i.id WHERE pt.project = ?", [req.params.id], function(taskError, taskRows) {
            taskRows.forEach(function(taskRow) {
              card.tasks.push(JSON.parse(taskRow.json));
            });
            res.render("cardDetails.ejs", card);
          });
      });
    });
  });
});

// Move :id to the state :state as an index into config.states
app.get("/move/:id/:state", function(req, res) {
  console.log("Moving a card");
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
      var issue = JSON.parse(rows[0].json);
      var labels = [];
      for (var i = 0; i < issue.labels.length; ++i) {
        if (issue.labels[i].name == rows[0].state) continue;
        labels.push(issue.labels[i].name);
      }
      labels.push(config.states[req.params.state].label);
      request({method:"delete", "url":issue.url + "/labels/" + rows[0].state, qs:{access_token:req.session.githubToken},json:true}, function(error, resp, body) {
        if (error) {
          console.dir(error);
          return res.redirect("/");
        }
        request({method:"post", "url":issue.url + "/labels", qs:{access_token:req.session.githubToken}, json:labels}, function(error, resp, body) {
          if (error) {
            console.dir(error);
          }
          updater.cacheIssue(issue.url, function(error) {
            return res.redirect("/");
          });
        });
      });
    });
  });
});

app.post("/create", function(req, res) {
  if (!req.body["project-title"]) {
    req.flash("error", "You did not specify a title");
  } else {
    var args = {
      accessToken:req.session.githubToken,
      title:req.body["project-title"],
      labels:[config.states[0].label]
    };
    if (req.body["project-description"]) args.description = req.body["project-description"];
    updater.createIssue(args, function() {
      res.redirect("/");
    });
  }
});

checkGithub(function(err) {
  if (err) {
    console.error("Error: " + err);
    return process.exit(1);
  }
  console.log("Checking configuration...");
  async.forEach(config.trackers, function(tracker, cb) {
    async.forEach(tracker.repos, function(repo, repoCb) {
      updater.getLabels(tracker.project, repo, function(labels) {
        async.forEach(config.states, function(state, stateCb) {
          var hasState = false;
          for (var i = 0; i < labels.length; ++i) {
            if (labels[i].name == state.label) {
              hasState = true;
              break;
            }
          }
          if (!hasState) {
            console.log("Creating " + state.label + " state on " + tracker.project + "/" + repo);
            updater.createLabel(tracker.project, repo, {name:state.label, color:state.color}, stateCb);
          } else {
            stateCb();
          }
        }, function() {
          repoCb();
        });
      });
    }, function() {
      cb();
    });
  }, function(err) {
    app.listen(process.env.PORT || 8326, function() {
      console.log("TeamBoard is listening!");
    });
  });
});
