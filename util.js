'use strict';

///Separate file for utilities used internally

/**
 * Gets rid of all nasty file system hacks that could happen
**/
function normalize(f) {
	return path.normalize(path.join("/", U.parse(f).pathname));
}

/**
 * Add n tab characters to the start of every line in s
**/
function tabify(s, n) {
	return (s + "").replace(/^/gm, '\t'.repeat((n|0) || 1));
}

/**
 * Universal logging
**/
function log(what) {
	what += "";
	fs.appendFile(path.join(__dirname, "out.log"),
		"{\n" +
			'\t"' + new Date() + '" [\n' +
				tabify(new Error().stack.toString(), 2) +
			"\n]\n\n" +
			"\twhat: `" + tabify(what).slice(1) + "`\n" +
		"}\n\n",
		() => {}
	);
}

class ExtendableError extends Error {
	constructor(message) {
		super(message);
		this.name = this.constructor.name;
		this.message = message; 
		Error.captureStackTrace(this, this.constructor);
	}
}

function dynamic_require(fn, next) {
	try {
		next(null, require(fn));
	}
	catch(e) {
		next(e, null);
	}
}

module.exports = {normalize, tabify, log, ExtendableError, dynamic_require};
