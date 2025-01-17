var SourceMapConsumer = require('@cspotcode/source-map-consumer').SourceMapConsumer;
var path = require('path');
var util = require('util');

var fs;
try {
  fs = require('fs');
  if (!fs.existsSync || !fs.readFileSync) {
    // fs doesn't have all methods we need
    fs = null;
  }
} catch (err) {
  /* nop */
}

/**
 * Requires a module which is protected against bundler minification.
 *
 * @param {NodeModule} mod
 * @param {string} request
 */
function dynamicRequire(mod, request) {
  return mod.require(request);
}

/**
 * @typedef {{
 *   enabled: boolean;
 *   originalValue: any;
 *   installedValue: any;
 * }} HookState
 * Used for installing and uninstalling hooks
 */

// Increment this if the format of sharedData changes in a breaking way.
var sharedDataVersion = 1;

function initializeSharedData(defaults) {
  var sharedDataKey = 'source-map-support/sharedData';
  if (typeof Symbol !== 'undefined') {
    sharedDataKey = Symbol.for(sharedDataKey);
  }
  var sharedData = this[sharedDataKey];
  if (!sharedData) {
    sharedData = { version: sharedDataVersion };
    if (Object.defineProperty) {
      Object.defineProperty(this, sharedDataKey, { value: sharedData });
    } else {
      this[sharedDataKey] = sharedData;
    }
  }
  if (sharedDataVersion !== sharedData.version) {
    throw new Error("Multiple incompatible instances of source-map-support were loaded");
  }
  for (var key in defaults) {
    if (!(key in sharedData)) {
      sharedData[key] = defaults[key];
    }
  }
  return sharedData;
}

// If multiple instances of source-map-support are loaded into the same
// context, they shouldn't overwrite each other.  By storing handlers, caches,
// and other state on a shared object, different instances of
// source-map-support can work together in a limited way. This does require
// that future versions of source-map-support continue to support the fields on
// this object. If this internal contract ever needs to be broken, increment
// sharedDataVersion. (This version number is not the same as any of the
// package's version numbers, which should reflect the *external* API of
// source-map-support.)
var sharedData = initializeSharedData({

  // Only install once if called multiple times
  // Remember how the environment looked before installation so we can restore if able
  /** @type {HookState} */
  errorPrepareStackTraceHook: undefined,
  /** @type {HookState} */
  processEmitHook: undefined,

  // If true, the caches are reset before a stack trace formatting operation
  emptyCacheBetweenOperations: false,

  // Maps a file path to a string containing the file contents
  fileContentsCache: {},

  // Maps a file path to a source map for that file
  sourceMapCache: {},

  // Priority list of retrieve handlers
  retrieveFileHandlers: [],
  retrieveMapHandlers: [],

  // Priority list of internally-implemented handlers.
  // When resetting state, we must keep these.
  internalRetrieveFileHandlers: [],
  internalRetrieveMapHandlers: [],

});

// Supports {browser, node, auto}
var environment = "auto";

// Regex for detecting source maps
var reSourceMap = /^data:application\/json[^,]+base64,/;

function isInBrowser() {
  if (environment === "browser")
    return true;
  if (environment === "node")
    return false;
  return ((typeof window !== 'undefined') && (typeof XMLHttpRequest === 'function') && !(window.require && window.module && window.process && window.process.type === "renderer"));
}

function hasGlobalProcessEventEmitter() {
  return ((typeof process === 'object') && (process !== null) && (typeof process.on === 'function'));
}

function handlerExec(list, internalList) {
  return function(arg) {
    for (var i = 0; i < list.length; i++) {
      var ret = list[i](arg);
      if (ret) {
        return ret;
      }
    }
    for (var i = 0; i < internalList.length; i++) {
      var ret = internalList[i](arg);
      if (ret) {
        return ret;
      }
    }
    return null;
  };
}

var retrieveFile = handlerExec(sharedData.retrieveFileHandlers, sharedData.internalRetrieveFileHandlers);

sharedData.internalRetrieveFileHandlers.push(function(path) {
  // Trim the path to make sure there is no extra whitespace.
  path = path.trim();
  if (/^file:/.test(path)) {
    // existsSync/readFileSync can't handle file protocol, but once stripped, it works
    path = path.replace(/file:\/\/\/(\w:)?/, function(protocol, drive) {
      return drive ?
        '' : // file:///C:/dir/file -> C:/dir/file
        '/'; // file:///root-dir/file -> /root-dir/file
    });
  }
  if (path in sharedData.fileContentsCache) {
    return sharedData.fileContentsCache[path];
  }

  var contents = '';
  try {
    if (!fs) {
      // Use SJAX if we are in the browser
      var xhr = new XMLHttpRequest();
      xhr.open('GET', path, /** async */ false);
      xhr.send(null);
      if (xhr.readyState === 4 && xhr.status === 200) {
        contents = xhr.responseText;
      }
    } else if (fs.existsSync(path)) {
      // Otherwise, use the filesystem
      contents = fs.readFileSync(path, 'utf8');
    }
  } catch (er) {
    /* ignore any errors */
  }

  return sharedData.fileContentsCache[path] = contents;
});

// Support URLs relative to a directory, but be careful about a protocol prefix
// in case we are in the browser (i.e. directories may start with "http://" or "file:///")
function supportRelativeURL(file, url) {
  if (!file) return url;
  var dir = path.dirname(file);
  var match = /^\w+:\/\/[^\/]*/.exec(dir);
  var protocol = match ? match[0] : '';
  var startPath = dir.slice(protocol.length);
  if (protocol && /^\/\w\:/.test(startPath)) {
    // handle file:///C:/ paths
    protocol += '/';
    return protocol + path.resolve(dir.slice(protocol.length), url).replace(/\\/g, '/');
  }
  return protocol + path.resolve(dir.slice(protocol.length), url);
}

function retrieveSourceMapURL(source) {
  var fileData;

  if (isInBrowser()) {
     try {
       var xhr = new XMLHttpRequest();
       xhr.open('GET', source, false);
       xhr.send(null);
       fileData = xhr.readyState === 4 ? xhr.responseText : null;

       // Support providing a sourceMappingURL via the SourceMap header
       var sourceMapHeader = xhr.getResponseHeader("SourceMap") ||
                             xhr.getResponseHeader("X-SourceMap");
       if (sourceMapHeader) {
         return sourceMapHeader;
       }
     } catch (e) {
     }
  }

  // Get the URL of the source map
  fileData = retrieveFile(source);
  var re = /(?:\/\/[@#][\s]*sourceMappingURL=([^\s'"]+)[\s]*$)|(?:\/\*[@#][\s]*sourceMappingURL=([^\s*'"]+)[\s]*(?:\*\/)[\s]*$)/mg;
  // Keep executing the search to find the *last* sourceMappingURL to avoid
  // picking up sourceMappingURLs from comments, strings, etc.
  var lastMatch, match;
  while (match = re.exec(fileData)) lastMatch = match;
  if (!lastMatch) return null;
  return lastMatch[1];
};

// Can be overridden by the retrieveSourceMap option to install. Takes a
// generated source filename; returns a {map, optional url} object, or null if
// there is no source map.  The map field may be either a string or the parsed
// JSON object (ie, it must be a valid argument to the SourceMapConsumer
// constructor).
var retrieveSourceMap = handlerExec(sharedData.retrieveMapHandlers, sharedData.internalRetrieveMapHandlers);
sharedData.internalRetrieveMapHandlers.push(function(source) {
  var sourceMappingURL = retrieveSourceMapURL(source);
  if (!sourceMappingURL) return null;

  // Read the contents of the source map
  var sourceMapData;
  if (reSourceMap.test(sourceMappingURL)) {
    // Support source map URL as a data url
    var rawData = sourceMappingURL.slice(sourceMappingURL.indexOf(',') + 1);
    sourceMapData = Buffer.from(rawData, "base64").toString();
    sourceMappingURL = source;
  } else {
    // Support source map URLs relative to the source URL
    sourceMappingURL = supportRelativeURL(source, sourceMappingURL);
    sourceMapData = retrieveFile(sourceMappingURL);
  }

  if (!sourceMapData) {
    return null;
  }

  return {
    url: sourceMappingURL,
    map: sourceMapData
  };
});

function mapSourcePosition(position) {
  var sourceMap = sharedData.sourceMapCache[position.source];
  if (!sourceMap) {
    // Call the (overrideable) retrieveSourceMap function to get the source map.
    var urlAndMap = retrieveSourceMap(position.source);
    if (urlAndMap) {
      sourceMap = sharedData.sourceMapCache[position.source] = {
        url: urlAndMap.url,
        map: new SourceMapConsumer(urlAndMap.map)
      };

      // Load all sources stored inline with the source map into the file cache
      // to pretend like they are already loaded. They may not exist on disk.
      if (sourceMap.map.sourcesContent) {
        sourceMap.map.sources.forEach(function(source, i) {
          var contents = sourceMap.map.sourcesContent[i];
          if (contents) {
            var url = supportRelativeURL(sourceMap.url, source);
            sharedData.fileContentsCache[url] = contents;
          }
        });
      }
    } else {
      sourceMap = sharedData.sourceMapCache[position.source] = {
        url: null,
        map: null
      };
    }
  }

  // Resolve the source URL relative to the URL of the source map
  if (sourceMap && sourceMap.map && typeof sourceMap.map.originalPositionFor === 'function') {
    var originalPosition = sourceMap.map.originalPositionFor(position);

    // Only return the original position if a matching line was found. If no
    // matching line is found then we return position instead, which will cause
    // the stack trace to print the path and line for the compiled file. It is
    // better to give a precise location in the compiled file than a vague
    // location in the original file.
    if (originalPosition.source !== null) {
      originalPosition.source = supportRelativeURL(
        sourceMap.url, originalPosition.source);
      return originalPosition;
    }
  }

  return position;
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin(origin) {
  // Most eval() calls are in this format
  var match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
  if (match) {
    var position = mapSourcePosition({
      source: match[2],
      line: +match[3],
      column: match[4] - 1
    });
    return 'eval at ' + match[1] + ' (' + position.source + ':' +
      position.line + ':' + (position.column + 1) + ')';
  }

  // Parse nested eval() calls using recursion
  match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
  if (match) {
    return 'eval at ' + match[1] + ' (' + mapEvalOrigin(match[2]) + ')';
  }

  // Make sure we still return useful information if we didn't find anything
  return origin;
}

// This is copied almost verbatim from the V8 source code at
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js. The
// implementation of wrapCallSite() used to just forward to the actual source
// code of CallSite.prototype.toString but unfortunately a new release of V8
// did something to the prototype chain and broke the shim. The only fix I
// could find was copy/paste.
function CallSiteToString() {
  var fileName;
  var fileLocation = "";
  if (this.isNative()) {
    fileLocation = "native";
  } else {
    fileName = this.getScriptNameOrSourceURL();
    if (!fileName && this.isEval()) {
      fileLocation = this.getEvalOrigin();
      fileLocation += ", ";  // Expecting source position to follow.
    }

    if (fileName) {
      fileLocation += fileName;
    } else {
      // Source code does not originate from a file and is not native, but we
      // can still get the source position inside the source string, e.g. in
      // an eval string.
      fileLocation += "<anonymous>";
    }
    var lineNumber = this.getLineNumber();
    if (lineNumber != null) {
      fileLocation += ":" + lineNumber;
      var columnNumber = this.getColumnNumber();
      if (columnNumber) {
        fileLocation += ":" + columnNumber;
      }
    }
  }

  var line = "";
  var isAsync = this.isAsync ? this.isAsync() : false;
  if(isAsync) {
    line += 'async ';
    var isPromiseAll = this.isPromiseAll ? this.isPromiseAll() : false;
    var isPromiseAny = this.isPromiseAny ? this.isPromiseAny() : false;
    if(isPromiseAny || isPromiseAll) {
      line += isPromiseAll ? 'Promise.all (index ' : 'Promise.any (index ';
      var promiseIndex = this.getPromiseIndex();
      line += promiseIndex + ')';
    }
  }
  var functionName = this.getFunctionName();
  var addSuffix = true;
  var isConstructor = this.isConstructor();
  var isMethodCall = !(this.isToplevel() || isConstructor);
  if (isMethodCall) {
    var typeName = this.getTypeName();
    // Fixes shim to be backward compatable with Node v0 to v4
    if (typeName === "[object Object]") {
      typeName = "null";
    }
    var methodName = this.getMethodName();
    if (functionName) {
      if (typeName && functionName.indexOf(typeName) != 0) {
        line += typeName + ".";
      }
      line += functionName;
      if (methodName && functionName.indexOf("." + methodName) != functionName.length - methodName.length - 1) {
        line += " [as " + methodName + "]";
      }
    } else {
      line += typeName + "." + (methodName || "<anonymous>");
    }
  } else if (isConstructor) {
    line += "new " + (functionName || "<anonymous>");
  } else if (functionName) {
    line += functionName;
  } else {
    line += fileLocation;
    addSuffix = false;
  }
  if (addSuffix) {
    line += " (" + fileLocation + ")";
  }
  return line;
}

function cloneCallSite(frame) {
  var object = {};
  Object.getOwnPropertyNames(Object.getPrototypeOf(frame)).forEach(function(name) {
    object[name] = /^(?:is|get)/.test(name) ? function() { return frame[name].call(frame); } : frame[name];
  });
  object.toString = CallSiteToString;
  return object;
}

function wrapCallSite(frame, state) {
  // provides interface backward compatibility
  if (state === undefined) {
    state = { nextPosition: null, curPosition: null }
  }
  if(frame.isNative()) {
    state.curPosition = null;
    return frame;
  }

  // Most call sites will return the source file from getFileName(), but code
  // passed to eval() ending in "//# sourceURL=..." will return the source file
  // from getScriptNameOrSourceURL() instead
  var source = frame.getFileName() || frame.getScriptNameOrSourceURL();
  if (source) {
    var line = frame.getLineNumber();
    var column = frame.getColumnNumber() - 1;

    // Fix position in Node where some (internal) code is prepended.
    // See https://github.com/evanw/node-source-map-support/issues/36
    // Header removed in node at ^10.16 || >=11.11.0
    // v11 is not an LTS candidate, we can just test the one version with it.
    // Test node versions for: 10.16-19, 10.20+, 12-19, 20-99, 100+, or 11.11
    var noHeader = /^v(10\.1[6-9]|10\.[2-9][0-9]|10\.[0-9]{3,}|1[2-9]\d*|[2-9]\d|\d{3,}|11\.11)/;
    var headerLength = noHeader.test(process.version) ? 0 : 62;
    if (line === 1 && column > headerLength && !isInBrowser() && !frame.isEval()) {
      column -= headerLength;
    }

    var position = mapSourcePosition({
      source: source,
      line: line,
      column: column
    });
    state.curPosition = position;
    frame = cloneCallSite(frame);
    var originalFunctionName = frame.getFunctionName;
    frame.getFunctionName = function() {
      if (state.nextPosition == null) {
        return originalFunctionName();
      }
      return state.nextPosition.name || originalFunctionName();
    };
    frame.getFileName = function() { return position.source; };
    frame.getLineNumber = function() { return position.line; };
    frame.getColumnNumber = function() { return position.column + 1; };
    frame.getScriptNameOrSourceURL = function() { return position.source; };
    return frame;
  }

  // Code called using eval() needs special handling
  var origin = frame.isEval() && frame.getEvalOrigin();
  if (origin) {
    origin = mapEvalOrigin(origin);
    frame = cloneCallSite(frame);
    frame.getEvalOrigin = function() { return origin; };
    return frame;
  }

  // If we get here then we were unable to change the source position
  return frame;
}

var kIsNodeError = undefined;
try {
  // Get a deliberate ERR_INVALID_ARG_TYPE
  // TODO is there a better way to reliably get an instance of NodeError?
  path.resolve(123);
} catch(e) {
  const symbols = Object.getOwnPropertySymbols(e);
  const symbol = symbols.find(function (s) {return s.toString().indexOf('kIsNodeError') >= 0});
  if(symbol) kIsNodeError = symbol;
}

const ErrorPrototypeToString = (err) =>Error.prototype.toString.call(err);

/** @param {HookState} hookState */
function createPrepareStackTrace(hookState) {
  return prepareStackTrace;

  // This function is part of the V8 stack trace API, for more info see:
  // https://v8.dev/docs/stack-trace-api
  function prepareStackTrace(error, stack) {
    if(!hookState.enabled) return hookState.originalValue.apply(this, arguments);

    if (sharedData.emptyCacheBetweenOperations) {
      sharedData.fileContentsCache = {};
      sharedData.sourceMapCache = {};
    }

    // node gives its own errors special treatment.  Mimic that behavior
    // https://github.com/nodejs/node/blob/3cbaabc4622df1b4009b9d026a1a970bdbae6e89/lib/internal/errors.js#L118-L128
    // https://github.com/nodejs/node/pull/39182
    var errorString;
    if (kIsNodeError) {
      if(kIsNodeError in error) {
        errorString = `${error.name} [${error.code}]: ${error.message}`;
      } else {
        errorString = ErrorPrototypeToString(error);
      }
    } else {
      var name = error.name || 'Error';
      var message = error.message || '';
      errorString = name + ": " + message;
    }

    var state = { nextPosition: null, curPosition: null };
    var processedStack = [];
    for (var i = stack.length - 1; i >= 0; i--) {
      processedStack.push('\n    at ' + wrapCallSite(stack[i], state));
      state.nextPosition = state.curPosition;
    }
    state.curPosition = state.nextPosition = null;
    return errorString + processedStack.reverse().join('');
  }
}

// Generate position and snippet of original source with pointer
function getErrorSource(error) {
  var match = /\n    at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack);
  if (match) {
    var source = match[1];
    var line = +match[2];
    var column = +match[3];

    // Support the inline sourceContents inside the source map
    var contents = sharedData.fileContentsCache[source];

    // Support files on disk
    if (!contents && fs && fs.existsSync(source)) {
      try {
        contents = fs.readFileSync(source, 'utf8');
      } catch (er) {
        contents = '';
      }
    }

    // Format the line from the original source code like node does
    if (contents) {
      var code = contents.split(/(?:\r\n|\r|\n)/)[line - 1];
      if (code) {
        return source + ':' + line + '\n' + code + '\n' +
          new Array(column).join(' ') + '^';
      }
    }
  }
  return null;
}

function printFatalErrorUponExit (error) {
  var source = getErrorSource(error);

  // Ensure error is printed synchronously and not truncated
  if (process.stderr._handle && process.stderr._handle.setBlocking) {
    process.stderr._handle.setBlocking(true);
  }

  if (source) {
    console.error(source);
  }

  // Matches node's behavior for colorized output
  console.error(
    util.inspect(error, {
      customInspect: false,
      colors: process.stderr.isTTY
    })
  );
}

function shimEmitUncaughtException () {
  const originalValue = process.emit;
  var hook = sharedData.processEmitHook = {
    enabled: true,
    originalValue,
    installedValue: undefined
  };
  var isTerminatingDueToFatalException = false;
  var fatalException;

  process.emit = sharedData.processEmitHook.installedValue = function (type) {
    const hadListeners = originalValue.apply(this, arguments);
    if(hook.enabled) {
      if (type === 'uncaughtException' && !hadListeners) {
        isTerminatingDueToFatalException = true;
        fatalException = arguments[1];
        process.exit(1);
      }
      if (type === 'exit' && isTerminatingDueToFatalException) {
        printFatalErrorUponExit(fatalException);
      }
    }
    return hadListeners;
  };
}

var originalRetrieveFileHandlers = sharedData.retrieveFileHandlers.slice(0);
var originalRetrieveMapHandlers = sharedData.retrieveMapHandlers.slice(0);

exports.wrapCallSite = wrapCallSite;
exports.getErrorSource = getErrorSource;
exports.mapSourcePosition = mapSourcePosition;
exports.retrieveSourceMap = retrieveSourceMap;

exports.install = function(options) {
  options = options || {};

  if (options.environment) {
    environment = options.environment;
    if (["node", "browser", "auto"].indexOf(environment) === -1) {
      throw new Error("environment " + environment + " was unknown. Available options are {auto, browser, node}")
    }
  }

  // Allow sources to be found by methods other than reading the files
  // directly from disk.
  if (options.retrieveFile) {
    if (options.overrideRetrieveFile) {
      sharedData.retrieveFileHandlers.length = 0;
    }

    sharedData.retrieveFileHandlers.unshift(options.retrieveFile);
  }

  // Allow source maps to be found by methods other than reading the files
  // directly from disk.
  if (options.retrieveSourceMap) {
    if (options.overrideRetrieveSourceMap) {
      sharedData.retrieveMapHandlers.length = 0;
    }

    sharedData.retrieveMapHandlers.unshift(options.retrieveSourceMap);
  }

  // Support runtime transpilers that include inline source maps
  if (options.hookRequire && !isInBrowser()) {
    // Use dynamicRequire to avoid including in browser bundles
    var Module = dynamicRequire(module, 'module');
    var $compile = Module.prototype._compile;

    if (!$compile.__sourceMapSupport) {
      Module.prototype._compile = function(content, filename) {
        sharedData.fileContentsCache[filename] = content;
        sharedData.sourceMapCache[filename] = undefined;
        return $compile.call(this, content, filename);
      };

      Module.prototype._compile.__sourceMapSupport = true;
    }
  }

  // Configure options
  if (!sharedData.emptyCacheBetweenOperations) {
    sharedData.emptyCacheBetweenOperations = 'emptyCacheBetweenOperations' in options ?
      options.emptyCacheBetweenOperations : false;
  }


  // Install the error reformatter
  if (!sharedData.errorPrepareStackTraceHook) {
    const originalValue = Error.prepareStackTrace;
    sharedData.errorPrepareStackTraceHook = {
      enabled: true,
      originalValue,
      installedValue: undefined
    };
    Error.prepareStackTrace = sharedData.errorPrepareStackTraceHook.installedValue = createPrepareStackTrace(sharedData.errorPrepareStackTraceHook);
  }

  if (!sharedData.processEmitHook) {
    var installHandler = 'handleUncaughtExceptions' in options ?
      options.handleUncaughtExceptions : true;

    // Do not override 'uncaughtException' with our own handler in Node.js
    // Worker threads. Workers pass the error to the main thread as an event,
    // rather than printing something to stderr and exiting.
    try {
      // We need to use `dynamicRequire` because `require` on it's own will be optimized by WebPack/Browserify.
      var worker_threads = dynamicRequire(module, 'worker_threads');
      if (worker_threads.isMainThread === false) {
        installHandler = false;
      }
    } catch(e) {}

    // Provide the option to not install the uncaught exception handler. This is
    // to support other uncaught exception handlers (in test frameworks, for
    // example). If this handler is not installed and there are no other uncaught
    // exception handlers, uncaught exceptions will be caught by node's built-in
    // exception handler and the process will still be terminated. However, the
    // generated JavaScript code will be shown above the stack trace instead of
    // the original source code.
    if (installHandler && hasGlobalProcessEventEmitter()) {
      shimEmitUncaughtException();
    }
  }
};

exports.uninstall = function() {
  if(sharedData.processEmitHook) {
    // Disable behavior
    sharedData.processEmitHook.enabled = false;
    // If possible, remove our hook function.  May not be possible if subsequent third-party hooks have wrapped around us.
    if(process.emit === sharedData.processEmitHook.installedValue) {
      process.emit = sharedData.processEmitHook.originalValue;
    }
    sharedData.processEmitHook = undefined;
  }
  if(sharedData.errorPrepareStackTraceHook) {
    // Disable behavior
    sharedData.errorPrepareStackTraceHook.enabled = false;
    // If possible or necessary, remove our hook function.
    // In vanilla environments, prepareStackTrace is `undefined`.
    // We cannot delegate to `undefined` the way we can to a function w/`.apply()`; our only option is to remove the function.
    // If we are the *first* hook installed, and another was installed on top of us, we have no choice but to remove both.
    if(Error.prepareStackTrace === sharedData.errorPrepareStackTraceHook.installedValue || typeof sharedData.errorPrepareStackTraceHook.originalValue !== 'function') {
      Error.prepareStackTrace = sharedData.errorPrepareStackTraceHook.originalValue;
    }
    sharedData.errorPrepareStackTraceHook = undefined;
  }
}

exports.resetRetrieveHandlers = function() {
  sharedData.retrieveFileHandlers.length = 0;
  sharedData.retrieveMapHandlers.length = 0;
}
