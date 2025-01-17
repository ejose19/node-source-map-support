// Note: some tests rely on side-effects from prior tests.
// You may not get meaningful results running a subset of tests.

const priorErrorPrepareStackTrace = Error.prepareStackTrace;
const priorProcessEmit = process.emit;
const underTest = require('./source-map-support');
var SourceMapGenerator = require('source-map').SourceMapGenerator;
var child_process = require('child_process');
var assert = require('assert');
var fs = require('fs');
var util = require('util');
var bufferFrom = Buffer.from;

function compareLines(actual, expected) {
  assert(actual.length >= expected.length, 'got ' + actual.length + ' lines but expected at least ' + expected.length + ' lines\n' + util.inspect({actual, expected}));
  for (var i = 0; i < expected.length; i++) {
    // Some tests are regular expressions because the output format changed slightly between node v0.9.2 and v0.9.3
    if (expected[i] instanceof RegExp) {
      assert(expected[i].test(actual[i]), JSON.stringify(actual[i]) + ' does not match ' + expected[i]);
    } else {
      assert.equal(actual[i], expected[i]);
    }
  }
}

function createEmptySourceMap() {
  return new SourceMapGenerator({
    file: '.generated.js',
    sourceRoot: '.'
  });
}

function createSourceMapWithGap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 100, column: 0 },
    original: { line: 100, column: 0 },
    source: '.original.js'
  });
  return sourceMap;
}

function createSingleLineSourceMap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: '.original.js'
  });
  return sourceMap;
}

function createSecondLineSourceMap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 2, column: 0 },
    original: { line: 1, column: 0 },
    source: '.original.js'
  });
  return sourceMap;
}

function createMultiLineSourceMap() {
  var sourceMap = createEmptySourceMap();
  for (var i = 1; i <= 100; i++) {
    sourceMap.addMapping({
      generated: { line: i, column: 0 },
      original: { line: 1000 + i, column: 99 + i },
      source: 'line' + i + '.js'
    });
  }
  return sourceMap;
}

function createMultiLineSourceMapWithSourcesContent() {
  var sourceMap = createEmptySourceMap();
  var original = new Array(1001).join('\n');
  for (var i = 1; i <= 100; i++) {
    sourceMap.addMapping({
      generated: { line: i, column: 0 },
      original: { line: 1000 + i, column: 4 },
      source: 'original.js'
    });
    original += '    line ' + i + '\n';
  }
  sourceMap.setSourceContent('original.js', original);
  return sourceMap;
}

function compareStackTrace(sourceMap, source, expected) {
  // Check once with a separate source map
  fs.writeFileSync('.generated.js.map', sourceMap.toString());
  fs.writeFileSync('.generated.js', 'exports.test = function() {' +
    source.join('\n') + '};//@ sourceMappingURL=.generated.js.map');
  try {
    delete require.cache[require.resolve('./.generated')];
    require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
  fs.unlinkSync('.generated.js.map');

  // Check again with an inline source map (in a data URL)
  fs.writeFileSync('.generated.js', 'exports.test = function() {' +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    delete require.cache[require.resolve('./.generated')];
    require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
}

function compareStdout(done, sourceMap, source, expected) {
  fs.writeFileSync('.original.js', 'this is the original code');
  fs.writeFileSync('.generated.js.map', sourceMap.toString());
  fs.writeFileSync('.generated.js', source.join('\n') +
    '//@ sourceMappingURL=.generated.js.map');
  child_process.exec('node ./.generated', function(error, stdout, stderr) {
    try {
      compareLines(
        (stdout + stderr)
          .trim()
          .split(/\r\n|\n/)
          .filter(function (line) { return line !== '' }), // Empty lines are not relevant.
        expected
      );
    } catch (e) {
      return done(e);
    }
    fs.unlinkSync('.generated.js');
    fs.unlinkSync('.generated.js.map');
    fs.unlinkSync('.original.js');
    done();
  });
}

it('normal throw without source-map-support installed', normalThrowWithoutSourceMapSupportInstalled);

it('normal throw', function() {
  installSms();
  normalThrow();
});
  
function installSms() {
  underTest.install({
    emptyCacheBetweenOperations: true // Needed to be able to test for failure
  });
}

function normalThrow() {
  compareStackTrace(createMultiLineSourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
}
function normalThrowWithoutSourceMapSupportInstalled() {
  compareStackTrace(createMultiLineSourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?\.generated\.js:1:34\)$/
  ]);
}

/* The following test duplicates some of the code in
 * `normal throw` but triggers file read failure.
 */
it('fs.readFileSync failure', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'var fs = require("fs");',
    'var rfs = fs.readFileSync;',
    'fs.readFileSync = function() {',
    '  throw new Error("no rfs for you");',
    '};',
    'try {',
    '  throw new Error("test");',
    '} finally {',
    '  fs.readFileSync = rfs;',
    '}'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line7\.js:1007:107\)$/
  ]);
});


it('throw inside function', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  throw new Error("test");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at foo \((?:.*[/\\])?line2\.js:1002:102\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line4\.js:1004:104\)$/
  ]);
});

it('throw inside function inside function', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  function bar() {',
    '    throw new Error("test");',
    '  }',
    '  bar();',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at bar \((?:.*[/\\])?line3\.js:1003:103\)$/,
    /^    at foo \((?:.*[/\\])?line5\.js:1005:105\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line7\.js:1007:107\)$/
  ]);
});

it('eval', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')");'
  ], [
    'Error: test',

    // Before Node 4, `Object.eval`, after just `eval`.
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,

    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('eval inside eval', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")\')");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('eval inside function', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  eval("throw new Error(\'test\')");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at eval \(eval at foo \((?:.*[/\\])?line2\.js:1002:102\)/,
    /^    at foo \((?:.*[/\\])?line2\.js:1002:102\)/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line4\.js:1004:104\)$/
  ]);
});

it('eval with sourceURL', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')//@ sourceURL=sourceURL.js");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(sourceURL\.js:1:7\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('eval with sourceURL inside eval', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")//@ sourceURL=sourceURL.js\')");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(sourceURL\.js:1:7\)$/,
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('native function', function() {
  compareStackTrace(createSingleLineSourceMap(), [
    '[1].map(function(x) { throw new Error(x); });'
  ], [
    'Error: 1',
    /[/\\].original\.js/,
    /at Array\.map \((native|<anonymous>)\)/
  ]);
});

it('function constructor', function() {
  compareStackTrace(createMultiLineSourceMap(), [
    'throw new Function(")");'
  ], [
    /SyntaxError: Unexpected token '?\)'?/,
  ]);
});

it('throw with empty source map', function() {
  compareStackTrace(createEmptySourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?\.generated.js:1:34\)$/
  ]);
});

it('throw in Timeout with empty source map', function(done) {
  compareStdout(done, createEmptySourceMap(), [
    'require("./source-map-support").install();',
    'setTimeout(function () {',
    '    throw new Error("this is the error")',
    '})'
  ], [
    /[/\\].generated.js:3$/,
    '    throw new Error("this is the error")',
    /^          \^$/,
    'Error: this is the error',
    /^    at ((null)|(Timeout))\._onTimeout \((?:.*[/\\])?.generated\.js:3:11\)$/
  ]);
});

it('throw with source map with gap', function() {
  compareStackTrace(createSourceMapWithGap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?\.generated\.js:1:34\)$/
  ]);
});

it('sourcesContent with data URL', function() {
  compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?original\.js:1001:5\)$/
  ]);
});

it('finds the last sourceMappingURL', function() {
  compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    '//# sourceMappingURL=missing.map.js',  // NB: compareStackTrace adds another source mapping.
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?original\.js:1002:5\)$/
  ]);
});

it('maps original name from source', function() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 2, column: 8 },
    original: { line: 1000, column: 10 },
    source: '.original.js',
  });
  sourceMap.addMapping({
    generated: { line: 4, column: 0 },
    original: { line: 1002, column: 1 },
    source: ".original.js",
    name: "myOriginalName"
  });
  compareStackTrace(sourceMap, [
    'function foo() {',
    '  throw new Error("test");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at myOriginalName \((?:.*[/\\])?\.original.js:1000:11\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?\.original.js:1002:2\)$/
  ]);
});

it('default options', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    /[/\\].original\.js:1$/,
    'this is the original code',
    '^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?\.original\.js:1:1\)$/
  ]);
});

it('handleUncaughtExceptions is true', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: true });',
    'process.nextTick(foo);'
  ], [
    /[/\\].original\.js:1$/,
    'this is the original code',
    '^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?\.original\.js:1:1\)$/
  ]);
});

it('handleUncaughtExceptions is false', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: false });',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',

    // Before Node 4, the arrow points on the `new`, after on the
    // `throw`.
    /^                 (?:      )?\^$/,

    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.original\.js:1:1\)$/
  ]);
});

it('default options with empty source map', function(done) {
  compareStdout(done, createEmptySourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',
    /^                 (?:      )?\^$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:2:24\)$/
  ]);
});

it('default options with source map with gap', function(done) {
  compareStdout(done, createSourceMapWithGap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',
    /^                 (?:      )?\^$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:2:24\)$/
  ]);
});

it('specifically requested error source', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'var sms = require("./source-map-support");',
    'sms.install({ handleUncaughtExceptions: false });',
    'process.on("uncaughtException", function (e) { console.log("SRC:" + sms.getErrorSource(e)); });',
    'process.nextTick(foo);'
  ], [
    /^SRC:.*[/\\]\.original\.js:1$/,
    'this is the original code',
    '^'
  ]);
});

it('sourcesContent', function(done) {
  compareStdout(done, createMultiLineSourceMapWithSourcesContent(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    /[/\\]original\.js:1002$/,
    '    line 2',
    '    ^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1002:5\)$/
  ]);
});

it('missing source maps should also be cached', function(done) {
  compareStdout(done, createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  overrideRetrieveSourceMap: true,',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) count++;',
    '    return null;',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:4:15\)$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:4:15\)$/,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should consult all retrieve source map providers', function(done) {
  compareStdout(done, createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) count++;',
    '    return undefined;',
    '  }',
    '});',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) {',
    '      count++;',
    '      return ' + JSON.stringify({url: '.original.js', map: createMultiLineSourceMapWithSourcesContent().toJSON()}) + ';',
    '    }',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1004:5\)$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1004:5\)$/,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should allow for runtime inline source maps', function(done) {
  var sourceMap = createMultiLineSourceMapWithSourcesContent();

  fs.writeFileSync('.generated.jss', 'foo');

  compareStdout(function(err) {
    fs.unlinkSync('.generated.jss');
    done(err);
  }, createSingleLineSourceMap(), [
    'require("./source-map-support").install({',
    '  hookRequire: true',
    '});',
    'require.extensions[".jss"] = function(module, filename) {',
    '  module._compile(',
        JSON.stringify([
          '',
          'var count = 0;',
          'function foo() {',
          '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
          '}',
          'process.nextTick(foo);',
          'process.nextTick(foo);',
          'process.nextTick(function() { console.log(count); });',
          '//@ sourceMappingURL=data:application/json;charset=utf8;base64,' + bufferFrom(sourceMap.toString()).toString('base64')
        ].join('\n')),
        ', filename);',
    '};',
    'require("./.generated.jss");',
  ], [
    'Error: this is the error',
    /^    at foo \(.*[/\\]original\.js:1004:5\)$/,
    'Error: this is the error',
    /^    at foo \(.*[/\\]original\.js:1004:5\)$/,
    '0', // The retrieval should only be attempted once
  ]);
});

/* The following test duplicates some of the code in
 * `compareStackTrace` but appends a charset to the
 * source mapping url.
 */
it('finds source maps with charset specified', function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ];

  fs.writeFileSync('.generated.js', 'exports.test = function() {' +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;charset=utf8;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    delete require.cache[require.resolve('./.generated')];
    require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
});

/* The following test duplicates some of the code in
 * `compareStackTrace` but appends some code and a
 * comment to the source mapping url.
 */
it('allows code/comments after sourceMappingURL', function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ];

  fs.writeFileSync('.generated.js', 'exports.test = function() {' +
    source.join('\n') + '};//# sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64') +
    '\n// Some comment below the sourceMappingURL\nvar foo = 0;');
  try {
    delete require.cache[require.resolve('./.generated')];
    require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
});

it('handleUncaughtExceptions is true with existing listener', function(done) {
  var source = [
    'process.on("uncaughtException", function() { /* Silent */ });',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    '//@ sourceMappingURL=.generated.js.map'
  ];

  fs.writeFileSync('.original.js', 'this is the original code');
  fs.writeFileSync('.generated.js.map', createSingleLineSourceMap().toString());
  fs.writeFileSync('.generated.js', source.join('\n'));

  child_process.exec('node ./.generated', function(error, stdout, stderr) {
    fs.unlinkSync('.generated.js');
    fs.unlinkSync('.generated.js.map');
    fs.unlinkSync('.original.js');
    assert.equal((stdout + stderr).trim(), '');
    done();
  });
});

it('normal console.trace', function(done) {
  compareStdout(done, createMultiLineSourceMap(), [
    'require("./source-map-support").install();',
    'console.trace("test");'
  ], [
    'Trace: test',
    /^    at Object\.<anonymous> \((?:.*[/\\])?line2\.js:1002:102\)$/
  ]);
});

it('supports multiple instances', function(done) {
  function finish(err) {
    fs.unlinkSync('.original2.js');
    fs.unlinkSync('.generated2.js');
    fs.unlinkSync('.generated2.js.map.extra')
    done(err);
  }
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: '.original2.js'
  });
  fs.writeFileSync('.generated2.js.map.extra', sourceMap.toString());
  fs.writeFileSync('.generated2.js', [
    'module.exports = function foo() { throw new Error("this is the error"); }',
    '//@ sourceMappingURL=.generated2.js.map'
  ].join('\n'));
  fs.writeFileSync('.original2.js', 'this is some other original code');
  compareStdout(finish, createEmptySourceMap(), [
    'require("./source-map-support").install({',
    '  retrieveFile: function(path) {',
    '    var fs = require("fs");',
    '    if (fs.existsSync(path + ".extra")) {',
    '      return fs.readFileSync(path + ".extra", "utf8");',
    '    }',
    '  }',
    '});',
    'var foo = require("./.generated2.js");',
    'delete require.cache[require.resolve("./source-map-support")];',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    /[/\\].original2\.js:1$/,
    'this is some other original code',
    '^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.original2\.js:1:1\)$/
  ]);
});

describe('uninstall', function() {
  this.beforeEach(function() {
    underTest.uninstall();
    process.emit = priorProcessEmit;
    Error.prepareStackTrace = priorErrorPrepareStackTrace;
  });

  it('uninstall removes hooks and source-mapping behavior', function() {
    assert.strictEqual(Error.prepareStackTrace, priorErrorPrepareStackTrace);
    assert.strictEqual(process.emit, priorProcessEmit);
    normalThrowWithoutSourceMapSupportInstalled();
  });

  it('install re-adds hooks', function() {
    installSms();
    normalThrow();
  });

  it('uninstall removes prepareStackTrace even in presence of third-party hooks if none were installed before us', function() {
    installSms();
    const wrappedPrepareStackTrace = Error.prepareStackTrace;
    let pstInvocations = 0;
    function thirdPartyPrepareStackTraceHook() {
      pstInvocations++;
      return wrappedPrepareStackTrace.apply(this, arguments);
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHook;
    underTest.uninstall();
    assert.strictEqual(Error.prepareStackTrace, undefined);
    assert(pstInvocations === 0);
  });

  it('uninstall preserves third-party prepareStackTrace hooks if one was installed before us', function() {
    let beforeInvocations = 0;
    function thirdPartyPrepareStackTraceHookInstalledBefore() {
      beforeInvocations++;
      return 'foo';
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHookInstalledBefore;
    installSms();
    const wrappedPrepareStackTrace = Error.prepareStackTrace;
    let afterInvocations = 0;
    function thirdPartyPrepareStackTraceHookInstalledAfter() {
      afterInvocations++;
      return wrappedPrepareStackTrace.apply(this, arguments);
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHookInstalledAfter;
    underTest.uninstall();
    assert.strictEqual(Error.prepareStackTrace, thirdPartyPrepareStackTraceHookInstalledAfter);
    assert.strictEqual(new Error().stack, 'foo');
    assert.strictEqual(beforeInvocations, 1);
    assert.strictEqual(afterInvocations, 1);
  });

  it('uninstall preserves third-party process.emit hooks installed after us', function() {
    installSms();
    const wrappedProcessEmit = process.emit;
    let peInvocations = 0;
    function thirdPartyProcessEmit() {
      peInvocations++;
      return wrappedProcessEmit.apply(this, arguments);
    }
    process.emit = thirdPartyProcessEmit;
    underTest.uninstall();
    assert.strictEqual(process.emit, thirdPartyProcessEmit);
    normalThrowWithoutSourceMapSupportInstalled();
    process.emit('foo');
    assert(peInvocations >= 1);
  });
});
