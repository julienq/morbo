"use strict";

// Morbo HTTP server

var fs = require("fs");
var http = require("http");
var path = require("path");
var url = require("url");
var util = require("util");

// Get flexo from: https://raw.github.com/bendr/bender/uninstance/flexo.js
var flexo = require("flexo");

var A = Array.prototype;

// These can (and sometime should) be overridden
exports.DOCUMENTS = path.join(process.cwd(), "docs");  // default document root
exports.SERVER_NAME = "MORBO!";                        // default server name

// Patterns for dispatch: applications will add their own patterns
// A pattern is of the form: [/path regex/, { GET: ..., PUT: ... }]
exports.PATTERNS = [];

// Known MIME types associated with file extensions
exports.TYPES = { css: "text/css", es: "application/ecmascript",
  html: "text/html", jpg: "image/jpeg", js: "application/javascript",
  json: "application/json", m4v: "video/mp4", manifest: "text/cache-manifest",
  mp3: "audio/mpeg", ogg: "audio/ogg", png: "image/png",
  pdf: "application/pdf", svg: "image/svg+xml",
  ttf: "application/octet-stream", wav: "audio/x-wav", xml: "application/xml",
  xhtml: "application/xhtml+xml", xslt: "application/xslt+xml"
};

// Known error codes
exports.STATUS_CODES = {
  // 1xx Informational
  100: "Continue", 101: "Switching Protocols",
  // 2xx Successful
  200: "OK", 201: "Created", 202: "Accepted",
  203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content",
  206: "Partial Content",
  // 3xx Redirection
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found",
  303: "See Other", 304: "See Other", 305: "Use Proxy",
  307: "Temporary Redirect",
  // 4xx Client error
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 407: "Proxy Authentication Required",
  408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required",
  412: "Precondition Failed", 413: "Request Entity Too Large",
  414: "Request-URI Too Long", 415: "Unsupported Media Type",
  416: "Request Range Not Satisfiable", 417: "Expectation Failed",
  418: "I'm a teapot",
  // 5xx Server error
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
  505: "HTTP Version Not Supported"
};


// Check that path p is rooted at root
function check_path(p, root) {
  root = path.normalize(root);
  var abs = path.normalize(p);
  return abs.substr(0, root.length) === root;
}

// Write the correct headers (plus the ones already given, if any)
function write_head(transaction, code, type, data, params) {
  if (typeof params !== "object") {
    params = {};
  }
  if (!params.hasOwnProperty("Accept-Ranges")) {
    params["Accept-Ranges"] = "bytes";
  }
  if (!params.hasOwnProperty("Content-Length")) {
    params["Content-Length"] = data ? Buffer.byteLength(data.toString()) : 0;
  }
  if (type && !params.hasOwnProperty("Content-Type")) {
    if (!(/\bcharset=/.test(type)) && /script|text|xml/.test(type)) {
      type += "; charset=utf-8";
    }
    params["Content-Type"] = type;
  }
  params.Date = (new Date()).toUTCString();
  params.Server = exports.SERVER_NAME;
  transaction.response.writeHead(code, params);
  transaction.log_info += " %0 %1".fmt(code, params["Content-Length"]);
}

// Serve a file from its actual path after we checked that it is indeed a
// file. Pass the stats result along to fill out the headers, and the URI if
// it was a directory request to set the Content-Location header
// TODO improve range request stuff (factor it out?)
function serve_file(transaction, p, stats, uri) {
  if (transaction.request.headers.hasOwnProperty("if-modified-since")) {
    var d = new Date(transaction.request.headers["if-modified-since"]);
    if (stats.mtime <= d) {
      transaction.serve_data(304);
      return;
    }
  }
  // TODO If-None-Match
  var type = exports.TYPES[path.extname(p).substr(1).toLowerCase()] || "";
  var params = {
    "Last-Modified": stats.mtime.toUTCString(),
    ETag: "\"%0-%1-%2\"".fmt(stats.ino.toString(16),
      stats.size.toString(16), stats.mtime.valueOf().toString(16)) };
  if (uri) {
    params["Content-Location"] = uri;
  }
  if (transaction.request.headers.hasOwnProperty("range")) {
    var m = (transaction.request.headers.range.match(/^bytes=(\d+)\-(\d*)/));
    if (m) {
      var from = parseInt(m[1], 10);
      var to = m[2] ? parseInt(m[2], 10) : stats.size - 1;
      var size = to - from + 1;
      if (size < stats.size) {
        var buffers = [];
        var length = 0;
        var file = fs.createReadStream(p);
        file.on("data", function (chunk) {
          buffers.push(chunk);
          length += chunk.length;
        });
        file.on("end", function () {
          var buffer = new Buffer(length);
          var pos = 0;
          buffers.forEach(function (b) {
            b.copy(buffer, pos);
            pos += b.length;
          });
          params["Content-Length"] = size;
          params["Content-Range"] = "bytes %0-%1/%2"
            .fmt(from, to, stats.size);
          write_head(transaction, 206, type, null, params);
          if (transaction.request.method.toUpperCase() === "HEAD") {
            transaction.response.end();
          } else {
            transaction.response.write(buffer.slice(from, from + size));
          }
        });
        return;
      }
    } else {
      transaction.serve_error(416, "Unsupported range request \"%0\""
          .fmt(transaction.request.headers.range));
      return;
    }
  }
  params["Content-Length"] = stats.size;
  write_head(transaction, 200, type, null, params);
  if (transaction.request.method.toUpperCase() === "HEAD") {
    transaction.response.end();
  } else {
    util.pump(fs.createReadStream(p), transaction.response);
  }
  util.log(transaction.log_info);
}

// Simply serve the requested file if found, otherwise return a 404/500 error or
// a 403 error if it's not a file. The dir parameter is set to the original
// directory path when we're looking for the implied index page; if not found,
// default to directory listing.
// TODO alternatives for index page
function serve_file_or_index(transaction, uri, dir) {
  var p = exports.get_local_path(uri);
  if (typeof p === "function") {
    return p.call(transaction);
  }
  fs.exists(p, function (exists) {
    if (!exists) {
      if (dir) {
        return exports.list_directory(transaction, dir);
      } else {
        return transaction.serve_error(404,
          "serve_file_or_index: File \"%0\" not found".fmt(p));
      }
    }
    fs.stat(p, function (error, stats) {
      if (error) {
        return transaction.serve_error(500,
          "serve_file_or_index: " + error);
      }
      if (stats.isFile()) {
        serve_file(transaction, p, stats, dir && uri);
      } else if (stats.isDirectory() && /\/$/.test(p)) {
        serve_file_or_index(transaction, path.join(uri, "index.html"), p);
      } else {
        transaction.serve_error(403,
          "serve_file_or_directory: no access to \"%0\"".fmt(p));
      }
    });
  });
}

// A transaction object so that we don't have to pass request/response
// everywhere
exports.TRANSACTION = {

  init: function (server, request, response) {
    this.server = server;
    this.request = request;
    this.response = response;
    this.url = url.parse(request.url, true);
    this.log_info = "%0 %1 %2".fmt(request.connection.remoteAddress,
        request.method, request.url);
    return this;
  },

  // Get the cookies from the request
  get_cookies: function () {
    var cookies = {};
    if (this.request.headers.cookie) {
      this.request.headers.cookie.split(";").forEach(function (cookie) {
        var parts = cookie.split("=");
        cookies[parts[0].trim()] = (parts[1] || "").trim();
      });
    }
    return cookies;
  },

  // Get data from the request
  get_data: function (f) {
    var data = "";
    this.request.on("data", function (chunk) { data += chunk.toString(); });
    this.request.on("error", function () { f(); });
    this.request.on("end", function () { f(data); });
  },

  // Serve data by writing the correct headers (plus the ones already given,
  // if any) and the data
  serve_data: function (code, type, data, params) {
    write_head(this, code, type, data, params);
    if (this.request.method.toUpperCase() === "HEAD") {
      this.response.end();
    } else {
      this.response.end(data);
    }
    util.log(this.log_info);
    if (this.log_error) {
      util.error(this.log_error);
    }
  },

  // Return an error as text with a code and an optional debug message
  // TODO provide a function to customize error pages
  serve_error: function (code, log) {
    exports.serve_error_page(this, code, log);
  },

  // Serve file from a known pathname
  serve_file_from_path: function (p, rel) {
    if (rel) {
      p = path.resolve(exports.DOCUMENTS, p);
    }
    fs.stat(p, function (error, stats) {
      if (error) {
        this.serve_error(500, "serve_file_from_path: " + error);
      } else if (!stats.isFile()) {
        this.serve_error(500,
            "serve_file_from_path: Expected a file at " + p);
      } else {
        serve_file(this, p, stats);
      }
    }.bind(this));
  },

  // Serve a string as an HTML document with an optional error code
  serve_html: function (html, code) {
    this.serve_data(code || 200, exports.TYPES.html, html);
  },

  // Return a js value encoded as JSON.
  // Set the raw flag to prevent the data to be reencoded.
  serve_json: function (result, raw) {
    var data = raw ? result : JSON.stringify(result);
    this.serve_data(200, exports.TYPES.json, data);
  },

  // Serve a string as plain text
  serve_text: function (text) {
    this.serve_data(200, exports.TYPES.text, text);
  },

  // Serve a string as an SVG document
  serve_svg: function (svg) {
    this.serve_data(200, exports.TYPES.svg, svg);
  }
};

// Get the local path for an URI path; if it is out of bounds, return an error
// function to be called by the transaction
exports.get_local_path = function (p) {
  var local_path = path.join(exports.DOCUMENTS, p);
  if (!check_path(local_path, exports.DOCUMENTS)) {
    return function () {
      this.serve_error(403, "Path \"%0\" is out of bounds".fmt(local_path));
    };
  }
  return local_path;
}

// Stub for directory listing. By default, this is disabled. Override this
// function in a module to enable directory listing.
exports.list_directory = function (transaction, dir) {
  transaction.serve_error(403,
      "serve_file_or_index: Directory listing is disallowed");
};

// Override this function in a module for fancier error pages.
exports.serve_error_page = function (transaction, code, log) {
  var msg = exports.STATUS_CODES[code] || "(unknown error code)";
  if (log) {
    transaction.log_error = "%0: %1 (%2)".fmt(code, msg, log);
  }
  transaction.serve_data(code, "text/plain", "%0 %1\n".fmt(code, msg));
};


// Run the server on the given port/ip, using the patterns list for dispatch
// (default is simply to serve a file in the DOCUMENTS directory with the given
// pathname.) A pattern action may return false if it turns out to not be able
// to actually handle the request.
exports.run = function (ip, port) {
  var server = http.createServer(function (request, response) {
    var transaction = Object.create(exports.TRANSACTION).init(exports, request,
      response);
    var pathname = decodeURIComponent(transaction.url.pathname);
    var method = request.method.toUpperCase();
    if (method === "HEAD") {
      method = "GET";
    }
    var handled = false;
    for (var i = 0, n = exports.PATTERNS.length; !handled && i < n; ++i) {
      var m = pathname.match(exports.PATTERNS[i][0]);
      if (m) {
        var methods = exports.PATTERNS[i][1];
        if (!methods.hasOwnProperty(method)) {
          var allowed = [];
          if (methods.hasOwnProperty("GET")) {
            allowed.push("HEAD");
          }
          A.push.apply(allowed, Object.keys(methods));
          transaction.response.setHeader("Allow", allowed.sort().join(", "));
          return transaction.serve_error(405,
            "Method %0 not allowed for %1".fmt(method, pathname));
        }
        var args = m.slice(1);
        args.unshift(transaction);
        handled = methods[method].apply(exports, args) !== false;
      }
    }
    if (!handled) {
      if (method === "GET") {
        serve_file_or_index(transaction, pathname);
      } else {
        transaction.response.setHeader("Allow", "GET, HEAD");
        transaction.serve_error(405,
          "Method %0 not allowed for %1".fmt(method, pathname));
      }
    }
  });
  server.listen(port, ip, function () {
    util.log("http://%0:%1 ready".fmt(ip || "localhost", port));
    util.log("Serving documents from %0".fmt(exports.DOCUMENTS));
  });
  return server;
};


// Make an HTML document
// Use html_page for quick header/footer; then flexo.$p(), &c. for contents

// Params should include at least "title"; "lang" and "charset" have default
// values. DOCTYPE can be overridden with the DOCTYPE parameter.
exports.html_header = function (params, head) {
  if (typeof params !== "object") {
    params = {};
  }
  if (head == null) {
    head = "";
  }
  if (!params.DOCTYPE) {
    params.DOCTYPE = "<!DOCTYPE html>";
  }
  if (!params.title) {
    params.title = "Untilted";
  }
  if (!params.charset) {
    params.charset = "UTF-8";
  }
  return params.DOCTYPE  + "\n" +
    flexo.$html({ lang: params.lang },
      flexo.$head(
        flexo.$title(params.title),
        flexo.$meta({ charset: params.charset }, true),
        head),
      flexo.$body(true), true);
};

exports.html_footer = function () {
  return "</body></html>";
};

exports.html_page = function (params, head, body) {
  return exports.html_header(params, head) + body + exports.html_footer();
};

// Parse arguments from the command line
function parse_args(argv) {
  var m;
  var args = { port: 8910, ip: "", apps: [] };
  argv.forEach(function (arg) {
    if (m = arg.match(/^-?-?port=(\d+)/i)) {
      args.port = parseInt(m[1], 10);
    } else if (m = arg.match(/^-?-?ip=(\S*)/i)) {
      args.ip = m[1];
    } else if (arg.match(/^-?-?h(elp)?$/i)) {
      args.help = true;
    } else if (m = arg.match(/^-?-?doc(?:ument)?s=(\S+)/)) {
      exports.DOCUMENTS = m[1];
    } else if (m = arg.match(/^-?-?app=(\S+)/i)) {
      args.apps.push(m[1]);
    }
  });
  return args;
}

// Show help info and quit
function show_help(node, name) {
  console.log("\nUsage: %0 %1 [options]\n\nOptions:".fmt(node, name));
  console.log("  app=<app.js>:       path to application file");
  console.log("  documents=<dir>:    path to the documents directory");
  console.log("  help:               show this help message");
  console.log("  ip=<ip address>:    IP address to listen to");
  console.log("  port=<port number>: port number for the server");
  console.log("");
  process.exit(0);
}

if (require.main === module) {
  var argv = process.argv.slice(2);
  var args = parse_args(argv);
  if (args.help) {
    show_help.apply(null, process.argv);
  }
  var seq = flexo.seq();
  seq.foreach(args.apps, function (appname, k) {
    util.log("App: %0 (%1)".fmt(appname, require.resolve(appname)));
    var app = require(appname);
    Array.prototype.unshift.apply(exports.PATTERNS, app.PATTERNS);
    if (typeof app.init === "function") {
      app.init(exports, argv, k);
    } else {
      k();
    }
  });
  seq.add(function () {
    var server = exports.run(args.ip, args.port);
    server.on("error", function (e) {
      console.error("http://%0:%1 error: %2".fmt(args.ip || "localhost",
          args.port, e.message));
      process.exit(1);
    });
  });
}
