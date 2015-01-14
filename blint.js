/*
 Simple linter, based on the Acorn [1] parser module

 All of the existing linters either cramp my style or have huge
 dependencies (Closure). So here's a very simple, non-invasive one
 that only spots

  - missing semicolons and trailing commas
  - variables or properties that are reserved words
  - assigning to a variable you didn't declare
  - access to non-whitelisted globals
    (use a '// declare global: foo, bar' comment to declare extra
    globals in a file)

 [1]: https://github.com/marijnh/acorn/
*/

var jsGlobals = "Infinity undefined NaN Object Function Array String Number Boolean RegExp Date Error SyntaxError ReferenceError URIError EvalError RangeError TypeError parseInt parseFloat isNaN isFinite eval encodeURI encodeURIComponent decodeURI decodeURIComponent Math JSON require console exports module".split(" ");
var browserGlobals = "location Node Element Text Document document XMLDocument HTMLElement HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBaseElement HTMLBodyElement HTMLBRElement HTMLButtonElement HTMLCanvasElement HTMLDataElement HTMLDataListElement HTMLDivElement HTMLDListElement HTMLDocument HTMLEmbedElement HTMLFieldSetElement HTMLFormControlsCollection HTMLFormElement HTMLHeadElement HTMLHeadingElement HTMLHRElement HTMLHtmlElement HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLKeygenElement HTMLLabelElement HTMLLegendElement HTMLLIElement HTMLLinkElement HTMLMapElement HTMLMediaElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLObjectElement HTMLOListElement HTMLOptGroupElement HTMLOptionElement HTMLOptionsCollection HTMLOutputElement HTMLParagraphElement HTMLParamElement HTMLPreElement HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSourceElement HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableDataCellElement HTMLTableElement HTMLTableHeaderCellElement HTMLTableRowElement HTMLTableSectionElement HTMLTextAreaElement HTMLTimeElement HTMLTitleElement HTMLTrackElement HTMLUListElement HTMLUnknownElement HTMLVideoElement Attr NodeList HTMLCollection NamedNodeMap DocumentFragment DOMTokenList XPathResult ClientRect Event TouchEvent WheelEvent MouseEvent KeyboardEvent HashChangeEvent ErrorEvent CustomEvent BeforeLoadEvent WebSocket Worker localStorage sessionStorage FileList File Blob FileReader URL Range XMLHttpRequest DOMParser Selection console top parent window opener self devicePixelRatio name closed pageYOffset pageXOffset scrollY scrollX screenTop screenLeft screenY screenX innerWidth innerHeight outerWidth outerHeight frameElement crypto navigator history screen postMessage close blur focus onload onunload onscroll onresize ononline onoffline onmousewheel onmouseup onmouseover onmouseout onmousemove onmousedown onclick ondblclick onmessage onkeyup onkeypress onkeydown oninput onpopstate onhashchange onfocus onblur onerror ondrop ondragstart ondragover ondragleave ondragenter ondragend ondrag oncontextmenu onchange onbeforeunload onabort getSelection alert confirm prompt scrollBy scrollTo scroll setTimeout clearTimeout setInterval clearInterval atob btoa addEventListener removeEventListener dispatchEvent getComputedStyle CanvasRenderingContext2D importScripts".split(" ");

var fs = require("fs"), acorn = require("acorn"), walk = require("acorn/util/walk.js");

var defaultOptions = {
  ecmaVersion: 5,
  browser: false,
  tabs: false,
  trailing: false,
  autoSemicolons: false,
  trailingCommas: false,
  reservedProps: false,
  declareGlobals: true,
  allowedGlobals: null,
  blob: false
};

function getOptions(value) {
  var opts = {};
  for (var prop in defaultOptions) {
    if (value && Object.prototype.hasOwnProperty.call(value, prop))
      opts[prop] = value[prop];
    else
      opts[prop] = defaultOptions[prop];
  }
  return opts;
}

var scopePasser = walk.make({
  ScopeBody: function(node, _prev, c) { c(node, node.scope); }
});

function checkFile(fileName, options) {
  options = getOptions(options);
  var file = fs.readFileSync(fileName, "utf8"), bad, msg;
  if (!options.trailing)
    bad = file.match(/[\t ]\n/);
  if (!bad && !options.tabs)
    bad = file.match(/\t/);
  if (!bad)
    bad = file.match(/[\x00-\x08\x0b\x0c\x0e-\x19\uFEFF]/);
  if (bad) {
    if (bad[0].indexOf("\n") > -1) msg = "Trailing whitespace";
    else if (bad[0] == "\t") msg = "Found tab character";
    else msg = "Undesirable character 0x" + bad[0].charCodeAt(0).toString(16);
    var info = acorn.getLineInfo(file, bad.index);
    fail(msg + " at line " + info.line + ", column " + info.column, {source: fileName});
  }

  if (options.blob && file.slice(0, options.blob.length) != options.blob)
    fail("Missing license blob", {source: fileName});

  var globalsSeen = Object.create(null);

  try {
    var parsed = acorn.parse(file, {
      locations: true,
      ecmaVersion: options.ecmaVersion,
      strictSemicolons: !options.autoSemicolons,
      allowTrailingCommas: options.trailingCommas,
      forbidReserved: options.reservedProps ? false : "everywhere",
      sourceFile: fileName
    });
  } catch (e) {
    fail(e.message, {source: fileName});
    return;
  }

  var scopes = [];

  function makeScope(prev, isCatch) {
    return {vars: Object.create(null), prev: prev, isCatch: isCatch};
  }
  function normalScope(scope) {
    while (scope.isCatch) scope = scope.prev;
    return scope;
  }

  var topScope = {vars: Object.create(null)};

  walk.recursive(parsed, topScope, {
    ScopeBody: function(node, scope, c) {
      node.scope = scope;
      scopes.push(scope);
      c(node, scope);
    },
    Function: function(node, scope, c) {
      var inner = makeScope(scope);
      for (var i = 0; i < node.params.length; ++i)
        inner.vars[node.params[i].name] = {type: "argument", node: node.params[i]};
      if (node.id) {
        var decl = node.type == "FunctionDeclaration";
        (decl ? normalScope(scope) : inner).vars[node.id.name] =
          {type: decl ? "function" : "function name", node: node.id};
      }
      c(node.body, inner, "ScopeBody");
    },
    TryStatement: function(node, scope, c) {
      c(node.block, scope, "Statement");
      if (node.handler) {
        var inner = makeScope(scope, true);
        inner.vars[node.handler.param.name] = {type: "catch clause", node: node.handler.param};
        c(node.handler.body, inner, "ScopeBody");
      }
      if (node.finalizer) c(node.finalizer, scope, "Statement");
    },
    VariableDeclaration: function(node, scope, c) {
      var target = normalScope(scope);
      for (var i = 0; i < node.declarations.length; ++i) {
        var decl = node.declarations[i];
        target.vars[decl.id.name] = {type: "var", node: decl.id};
        if (decl.init) c(decl.init, scope, "Expression");
      }
    }
  }, null);

  var ignoredGlobals = Object.create(null);

  function inScope(name, scope) {
    for (var cur = scope; cur; cur = cur.prev)
      if (name in cur.vars) return true;
  }
  function checkLHS(node, scope) {
    if (node.type == "Identifier" && !(node.name in ignoredGlobals) &&
        !inScope(node.name, scope)) {
      ignoredGlobals[node.name] = true;
      fail("Assignment to global variable " + node.name + ".", node.loc);
    }
  }

  walk.simple(parsed, {
    UpdateExpression: function(node, scope) {checkLHS(node.argument, scope);},
    AssignmentExpression: function(node, scope) {checkLHS(node.left, scope);},
    Identifier: function(node, scope) {
      if (node.name == "arguments") return;
      // Mark used identifiers
      for (var cur = scope; cur; cur = cur.prev)
        if (node.name in cur.vars) {
          cur.vars[node.name].used = true;
          return;
        }
      globalsSeen[node.name] = node.loc;
    },
    FunctionExpression: function(node) {
      if (node.id) fail("Named function expression", node.loc);
    },
    ForStatement: function(node) {
      checkReusedIndex(node);
      if (node.test && node.update)
        checkObviousInfiniteLoop(node.test, node.update);
    },
    MemberExpression: function(node) {
      if (node.object.type == "Identifier" && node.object.name == "console" && !node.computed)
        fail("Found console." + node.property.name, node.loc);
    },
    DebuggerStatement: function(node) {
      fail("Found debugger statement", node.loc);
    }
  }, scopePasser, topScope);

  function checkReusedIndex(node) {
    if (!node.init || node.init.type != "VariableDeclaration") return;
    var name = node.init.declarations[0].id.name;
    walk.recursive(node.body, null, {
      Function: function() {},
      VariableDeclaration: function(node, st, c) {
        for (var i = 0; i < node.declarations.length; i++)
          if (node.declarations[i].id.name == name)
            fail("redefined loop variable", node.declarations[i].id.loc);
        walk.base.VariableDeclaration(node, st, c);
      }
    });
  }

  function checkObviousInfiniteLoop(test, update) {
    var vars = Object.create(null);
    function opDir(op) {
      if (/[<+]/.test(op)) return 1;
      if (/[->]/.test(op)) return -1;
      return 0;
    }
    function store(name, dir) {
      if (!(name in vars)) vars[name] = {below: false, above: false};
      if (dir > 0) vars[name].up = true;
      if (dir < 0) vars[name].down = true;
    }
    function check(node, dir) {
      var known = vars[node.name];
      if (!known) return;
      if (dir > 0 && known.down && !known.up ||
          dir < 0 && known.up && !known.down)
        fail("Suspiciously infinite-looking loop", node.loc);
    }
    walk.simple(test, {
      BinaryExpression: function(node) {
        if (node.left.type == "Identifier")
          store(node.left.name, opDir(node.operator));
        if (node.right.type == "Identifier")
          store(node.right.name, -opDir(node.operator));
      }
    });
    walk.simple(update, {
      UpdateExpression: function(node) {
        if (node.argument.type == "Identifier")
          check(node.argument, opDir(node.operator));
      },
      AssignmentExpression: function(node) {
        if (node.left.type == "Identifier") {
          if (node.operator == "=" && node.right.type == "BinaryExpression" && node.right.left.name == node.left.name)
            check(node.left, opDir(node.right.operator));
          else
            check(node.left, opDir(node.operator));
        }
      }
    });
  }

  var allowedGlobals = Object.create(options.declareGlobals ? topScope.vars : null), m;
  if (options.allowedGlobals) options.allowedGlobals.forEach(function(v) { allowedGlobals[v] = true; });
  for (var i = 0; i < jsGlobals.length; i++) allowedGlobals[jsGlobals[i]] = true;
  if (options.browser)
    for (var i = 0; i < browserGlobals.length; i++) allowedGlobals[browserGlobals[i]] = true;

  if (m = file.match(/\/\/ declare global:\s+(.*)/))
    m[1].split(/,\s*/g).forEach(function(n) { allowedGlobals[n] = true; });
  for (var glob in globalsSeen)
    if (!(glob in allowedGlobals))
      fail("Access to global variable " + glob + ".", globalsSeen[glob]);

  for (var i = 0; i < scopes.length; ++i) {
    var scope = scopes[i];
    for (var name in scope.vars) {
      var info = scope.vars[name];
      if (!info.used && info.type != "catch clause" && info.type != "function name" && name.charAt(0) != "_")
        fail("Unused " + info.type + " " + name, info.node.loc);
    }
  }
}

var failed = false;
function fail(msg, pos) {
  if (pos.start) msg += " (" + pos.start.line + ":" + pos.start.column + ")";
  console["log"](pos.source + ": " + msg);
  failed = true;
}

function checkDir(dir, options) {
  fs.readdirSync(dir).forEach(function(file) {
    var fname = dir + "/" + file;
    if (/\.js$/.test(file)) checkFile(fname, options);
    else if (fs.lstatSync(fname).isDirectory()) checkDir(fname, options);
  });
}

exports.checkDir = checkDir;
exports.checkFile = checkFile;
exports.success = function() { return !failed; };
