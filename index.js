'use strict';

const
	http = require("http"),
	path = require("path"),
	mime = require("mime"),
	zlib = require("zlib"),
	stream = require("stream"),
	U = require("url"),
	fs = require("fs");

const util = require("./util");

class NotImplemented extends util.ExtendableError {}

/**
 * Handles all of the logic you might need for sending most data back to the
 *  client.
**/
function send(req, res, config) {
	let s = (function() {
		if(config.filename) {
			let f = config.filename;
			
			res.setHeader("Content-Type", mime.lookup(f));
			
			return fs.createReadStream(f);
		}
		else if(config.data) {
			let s = new stream.Readable();
			s._read = function() {};
			s.push(config.data);
			s.push(null);
			
			if(config.mime) {
				res.setHeader("Content-Type", config.mime);
			}
			
			return s;
		}
	})();
	
	let avail = req.headers["accept-encoding"].split(/\s*,\s*/g);
	
	res.status = config.status || 200;
	
	if(avail.indexOf("gzip") != -1) {
		res.setHeader("Content-Encoding", "gzip");
		s.pipe(zlib.createGzip()).pipe(res);
	}
	else if(avail.indexOf("deflate") != -1) {
		res.setHeader("Content-Encoding", "deflate");
		s.pipe(zlib.createDeflate()).pipe(res);
	}
	else {
		s.pipe(res);
	}
}

/**
 * Interface for all routers.
**/
class Router {
	route(root, req, res, next) {
		throw new NotImplemented("Router.route(root, i, o, next)")
	}
}

/**
 * Wraps a given function in a router.
**/
class Raw extends Router {
	constructor(route) {
		this.route = route;
	}
}

/**
 * A router that responds when looking at something which matches the given uri.
**/
class Simple extends Router {
	constructor(uri, handle) {
		if(typeof uri == "string") {
			this.uri = function(r, i) {
				return i.path == uri;
			}
		}
		else if(uri instanceof RegExp) {
			this.uri = function(r, i) {
				return uri.test(i);
			}
		}
		else if(typeof uri == "function") {
			this.uri = uri;
		}
		
		this.handle = handle;
	}
	
	route(root, i, o, next) {
		if(this.uri(i)) {
			this.handle(root, i, o, next);
		}
		else {
			next();
		}
	}
}

/**
 * Interface for all file handlers, which are used in some routers to abstract
 *  specific file extensions. The filename given in process is assumed to
 *  refer to a real file.
**/
class Handler {
	process(i, o, f) {
		
	}
}

class Cached extends Handler {
	constructor(build) {
		this.build = build;
		this.cache = {};
	}
	
	process(router, req, res, lfn) {
		if(this.cache[lfn]) {
			this.cache[lfn].process(router, req, res);
			return;
		}
		
		fs.stat(lfn, (err, stat) => {
			if(err) {
				router.error(req, res, 404);
			}
			else {
				this.build.build(lfn, (err, data) => {
					if(err) {
						router.error(req, res, err);
					}
					else {
						this.cache[lfn] = data;
						data.process(router, req, res);
					}
				});
			}
		});
	}
}

/**
 * Handler for dynamic files, anything ending with ! which is expected to
 *  change within the same session even with the same path.
**/
class Dynamic extends Handler {
	constructor() {
		this.cache = new Cached({
			build: dynamic_require
		});
	}
	
	route(router, req, res, lfn, next) {
		if(lfn.endsWith("!")) {
			this.cache.process(router, req, res, lfn);
		}
		else {
			next();
		}
	}
}

/**
 * Acts as a kind of switchboard for subdomains.
**/
class Subdomain extends Router {
	constructor(sub) {
		this.sub = sub;
	}
	
	route(root, i, o, next) {
		let s = this.sub[i.host.split('.')[i.depth] || ""] || this.sub["?"];
		
		if(s) {
			s.route(root, i, o, next);
		}
		else {
			next();
		}
	}
}

/**
 * Router for static files.
**/
class Static extends Router {
	constructor(config) {
		this.base = config.base || process.cwd();
		this.handlers = config.handlers || [];
		this.ls = config.ls || new Template(
			path.join(__dirname, "default", "ls.js")
		);
		this.error = config.error;
		this.all = !!config.all;
	}
	
	route(root, i, o, next) {
		let x = 0, self = this, f = path.join(
			this.base, path.normalize(path.join("/", i.path))
		);
		this.handles[x].route(root, i, o, function nn() {
			if(x + 1 < self.handles.length) {
				self.handles[++x].route(root, i, o, nn);
			}
			else {
				//Check for hidden path components
				if(this.all || f.indexOf(path.sep + ".") == -1) {
					fs.stat(f, function(err, stat) {
						if(err) {
							self.error(req, res, 404);
						}
						else if(stat.isDirectory()) {
							fs.readdir(f, function(err, files) {
								//Assumption: err == null
								
								for(let x of files) {
									if(/^index.+$/.test(x)) {
										send(req, res, {
											filename: path.join(f, x)
										})
										return;
									}
								}
								
								self.ls(req, res, f);
							});
						}
						else if(stat.isFile()) {
							let ext = path.extname(f);
							if(ext in self.ext) {
								self.ext[ext].process(self, req, res, f);
							}
							else if("*" in self.ext) {
								self.ext["*"].process(self, req, res, f);
							}
							else {
								send(req, res, {
									filename: f
								});
							}
						}
						//What is this even, just 404
						else {
							self.error(req, 
							res, 404);
						}
					});
				}
				//Looks like a hidden file, just say it is
				else {
					self.error(req, res, 403);
				}
			}
		});
	}
}

class Domain {
	constructor(sub, error) {
		this.sub = sub;
		this.error = error;
	}
	
	route(req, res) {
		let
			m = /(?:(.*?)\.)?[^\s.]+\.[^\s.]+/g.exec(req.headers.host),
			sub = m && m[1] || "";
		if(sub in this.sub) {
			this.sub[sub].route(req, res);
		}
		else {
			let w = this.sub["*"];
			if(w) {
				w.route(req, res);
			}
			else {
				this.error(req, res, 404)
			}
		}
	}
}

function default_error(req, res, err) {
	if(typeof err == "number") {
		send(req, res, {
			mime: "text/plain",
			data: "Generated error code " + err + " while processing URI " +
				req.url + " (no error handler specified)\n"
		});
	}
	else {
		send(req, res, {
			status: 500,
			mime: "text/plain",
			data: "While processing URI " + req.url +
				" the following error occurred:\n\n" + err.stack +
				"\n(no error handler specified)\n"
		});
	}
}

function default_ls(req, res, dir) {
	fs.readdir(dir, function(err, files) {
		if(err) {
			log(req.headers.host + " listing failed due to:\n" + err);
		}
		else {
			let url = normalize(req.url);
			
			send(req, res, {
				mime: "txt/html",
				data:
					"<!DOCTYPE html>" +
					"<html>" +
						"<head>" +
							"<title>Index of " + url + "</title>" +
						"</head>" +
						"<body>" +
							"<h3>Index of " + url + "</h3>" +
							"<ul>" +
								files.map(function(v) {
									return (
										"<li>" +
											'<a href="' +
												path.join(url, v) +
											'">' +
												v +
											"</a>" +
										"</li>"
									)
								}).join("") +
							"</ul>" +
						"</body>" +
					"</html>"
			});
		}
	});
}

module.exports = {
	Cached, Dynamic, Default, Domain, Router,
	log, default_error, default_ls, dynamic_require, send
};
