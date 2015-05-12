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

var jsGlobals = "Infinity undefined NaN Object Function Array String Number Boolean RegExp Date Error SyntaxError ReferenceError URIError EvalError RangeError TypeError parseInt parseFloat isNaN isFinite eval encodeURI encodeURIComponent decodeURI decodeURIComponent Math JSON require console exports module Symbol".split(" ");
var browserGlobals = "location Node Element Text Document document XMLDocument HTMLElement HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBaseElement HTMLBodyElement HTMLBRElement HTMLButtonElement HTMLCanvasElement HTMLDataElement HTMLDataListElement HTMLDivElement HTMLDListElement HTMLDocument HTMLEmbedElement HTMLFieldSetElement HTMLFormControlsCollection HTMLFormElement HTMLHeadElement HTMLHeadingElement HTMLHRElement HTMLHtmlElement HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLKeygenElement HTMLLabelElement HTMLLegendElement HTMLLIElement HTMLLinkElement HTMLMapElement HTMLMediaElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLObjectElement HTMLOListElement HTMLOptGroupElement HTMLOptionElement HTMLOptionsCollection HTMLOutputElement HTMLParagraphElement HTMLParamElement HTMLPreElement HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSourceElement HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableDataCellElement HTMLTableElement HTMLTableHeaderCellElement HTMLTableRowElement HTMLTableSectionElement HTMLTextAreaElement HTMLTimeElement HTMLTitleElement HTMLTrackElement HTMLUListElement HTMLUnknownElement HTMLVideoElement Attr NodeList HTMLCollection NamedNodeMap DocumentFragment DOMTokenList XPathResult ClientRect Event TouchEvent WheelEvent MouseEvent KeyboardEvent HashChangeEvent ErrorEvent CustomEvent BeforeLoadEvent WebSocket Worker localStorage sessionStorage FileList File Blob FileReader URL Range XMLHttpRequest DOMParser Selection console top parent window opener self devicePixelRatio name closed pageYOffset pageXOffset scrollY scrollX screenTop screenLeft screenY screenX innerWidth innerHeight outerWidth outerHeight frameElement crypto navigator history screen postMessage close blur focus onload onunload onscroll onresize ononline onoffline onmousewheel onmouseup onmouseover onmouseout onmousemove onmousedown onclick ondblclick onmessage onkeyup onkeypress onkeydown oninput onpopstate onhashchange onfocus onblur onerror ondrop ondragstart ondragover ondragleave ondragenter ondragend ondrag oncontextmenu onchange onbeforeunload onabort getSelection alert confirm prompt scrollBy scrollTo scroll setTimeout clearTimeout setInterval clearInterval atob btoa addEventListener removeEventListener dispatchEvent getComputedStyle CanvasRenderingContext2D importScripts".split(" ");

var fs = require("fs"), acorn = require("acorn"), walk = require("acorn/dist/walk.js");

var defaultOptions = {
  ecmaVersion: 5,
  browser: false,
  tabs: false,
  trailing: false,
  semicolons: null,
  trailingCommas: false,
  reservedProps: false,
  namedFunctions: false,
  declareGlobals: true,
  allowedGlobals: null,
  blob: false,
  message: null
};

function getOptions(value) {
  var opts = {};
  if (value.autoSemicolons === false) value.semicolons = true;
  for (var prop in defaultOptions) {
    if (value && Object.prototype.hasOwnProperty.call(value, prop))
      opts[prop] = value[prop];
    else
      opts[prop] = defaultOptions[prop];
  }
  return opts;
}

var scopePasser = walk.make({
  Statement: function(node, prev, c) { c(node, node.scope || prev); },
  Function: function(node, _prev, c) { walk.base.Function(node, node.scope, c) }
});

function checkFile(fileName, options, text) {
  options = getOptions(options);
  if (text == null) text = fs.readFileSync(fileName, "utf8");

  var bad, msg;
  if (!options.trailing)
    bad = text.match(/[\t ]\n/);
  if (!bad && !options.tabs)
    bad = text.match(/\t/);
  if (!bad)
    bad = text.match(/[\x00-\x08\x0b\x0c\x0e-\x19\uFEFF]/);
  if (bad) {
    if (bad[0].indexOf("\n") > -1) msg = "Trailing whitespace";
    else if (bad[0] == "\t") msg = "Found tab character";
    else msg = "Undesirable character 0x" + bad[0].charCodeAt(0).toString(16);
    var info = acorn.getLineInfo(text, bad.index);
    fail(msg, {start: info, source: fileName});
  }

  if (options.blob && text.slice(0, options.blob.length) != options.blob)
    fail("Missing license blob", {source: fileName});

  var globalsSeen = Object.create(null);

  try {
    var ast = acorn.parse(text, {
      locations: true,
      ecmaVersion: options.ecmaVersion,
      onInsertedSemicolon: options.semicolons !== true ? null : function(_, loc) {
        fail("Missing semicolon", {source: fileName, start: loc});
      },
      onTrailingComma: options.trailingCommas ? null : function(_, loc) {
        fail("Trailing comma", {source: fileName, start: loc});
      },
      forbidReserved: options.reservedProps ? false : "everywhere",
      sourceFile: fileName,
      sourceType: "module"
    });
  } catch (e) {
    fail(e.message, {source: fileName});
    return;
  }

  if (options.semicolons === false)
    require("./nosemicolons")(text, ast, fail)

  var scopes = [];

  function makeScope(prev, type) {
    var scope = {vars: Object.create(null), prev: prev, type: type};
    scopes.push(scope);
    return scope;
  }
  function fnScope(scope) {
    while (scope.type != "fn") scope = scope.prev;
    return scope;
  }
  function addVar(scope, name, type, node, deadZone, written) {
    if (deadZone && (name in scope.vars))
      fail("Duplicate definition of " + name, node.loc);
    scope.vars[name] = {type: type, node: node, deadZone: deadZone && scope,
                        written: written, read: false};
  }

  function makeCx(scope, binding) {
    return {scope: scope, binding: binding};
  }

  function isBlockScopedDecl(node) {
    return node.type == "VariableDeclaration" && node.kind != "var";
  }

  var topScope = makeScope(null, "fn");

  walk.recursive(ast, makeCx(topScope), {
    Function: function(node, cx, c) {
      var inner = node.scope = node.body.scope = makeScope(cx.scope, "fn");
      var innerCx = makeCx(inner, {scope: inner, type: "argument", deadZone: true, written: true});
      for (var i = 0; i < node.params.length; ++i)
        c(node.params[i], innerCx, "Pattern");

      if (node.id) {
        var decl = node.type == "FunctionDeclaration";
        addVar(decl ? cx.scope : inner, node.id.name,
               decl ? "function" : "function name", node.id, false, true);
      }
      c(node.body, innerCx, "ScopeBody");
    },
    TryStatement: function(node, cx, c) {
      c(node.block, cx, "Statement");
      if (node.handler) {
        var inner = node.handler.body.scope = makeScope(cx.scope, "block");
        addVar(inner, node.handler.param.name, "catch clause", node.handler.param, false, true);
        c(node.handler.body, makeCx(inner), "ScopeBody");
      }
      if (node.finalizer) c(node.finalizer, cx, "Statement");
    },
    Class: function(node, cx, c) {
      if (node.id && node.type == "ClassDeclaration")
        addVar(cx.scope, node.id.name, "class name", node, true, true);
      if (node.superClass) c(node.superClass, cx, "Expression");
      for (var i = 0; i < node.body.body.length; i++)
        c(node.body.body[i], cx);
    },
    ImportDeclaration: function(node, cx, c) {
      for (var i = 0; i < node.specifiers.length; i++) {
        var spec = node.specifiers[i].local
        addVar(cx.scope, spec.name, "import", spec, false, true)
      }
    },
    Expression: function(node, cx, c) {
      if (cx.binding) cx = makeCx(cx.scope)
      c(node, cx);
    },
    VariableDeclaration: function(node, cx, c) {
      for (var i = 0; i < node.declarations.length; ++i) {
        var decl = node.declarations[i];
        c(decl.id, makeCx(cx.scope, {
          scope: node.kind == "var" ? fnScope(cx.scope) : cx.scope,
          type: node.kind == "const" ? "constant" : "variable",
          deadZone: node.kind != "var",
          written: !!decl.init
        }), "Pattern");
        if (decl.init) c(decl.init, cx, "Expression");
      }
    },
    VariablePattern: function(node, cx, c) {
      var b = cx.binding;
      if (b) addVar(b.scope, node.name, b.type, node, b.deadZone, b.written);
    },
    BlockStatement: function(node, cx, c) {
      if (!node.scope && node.body.some(isBlockScopedDecl)) {
        node.scope = makeScope(cx.scope, "block");
        cx = makeCx(node.scope)
      }
      walk.base.BlockStatement(node, cx, c);
    },
    ForInStatement: function(node, cx, c) {
      if (!node.scope && isBlockScopedDecl(node.left)) {
        node.scope = node.body.scope = makeScope(cx.scope, "block");
        cx = makeCx(node.scope);
      }
      walk.base.ForInStatement(node, cx, c);
    },
    ForStatement: function(node, cx, c) {
      if (!node.scope && node.init && isBlockScopedDecl(node.init)) {
        node.scope = node.body.scope = makeScope(cx.scope, "block");
        cx = makeCx(node.scope);
      }
      walk.base.ForStatement(node, cx, c);
    }
  }, null);

  var ignoredGlobals = Object.create(null);

  var checkWalker = {
    UpdateExpression: function(node, scope) {assignToPattern(node.argument, scope);},
    AssignmentExpression: function(node, scope) {assignToPattern(node.left, scope);},
    Identifier: function(node, scope) {
      if (node.name == "arguments") return;
      readVariable(node, scope);
    },
    ExportNamedDeclaration: function(node, scope) {
      if (!node.source) for (var i = 0; i < node.specifiers.length; i++)
        readVariable(node.specifiers[i].local, scope);
      exportDecl(node.declaration, scope);
    },
    ExportDefaultDeclaration: function(node, scope) {
      exportDecl(node.declaration, scope);
    },
    FunctionExpression: function(node) {
      if (node.id && !options.namedFunctions) fail("Named function expression", node.loc);
    },
    ForStatement: function(node) {
      checkReusedIndex(node);
      if (node.test && node.update)
        checkObviousInfiniteLoop(node.test, node.update);
    },
    ForInStatement: function(node, scope) {
      assignToPattern(node.left.type == "VariableDeclaration" ? node.left.declarations[0].id : node.left, scope);
    },
    MemberExpression: function(node) {
      if (node.object.type == "Identifier" && node.object.name == "console" && !node.computed)
        fail("Found console." + node.property.name, node.loc);
    },
    DebuggerStatement: function(node) {
      fail("Found debugger statement", node.loc);
    }
  };

  function check(node, scope) {
    walk.simple(node, checkWalker, scopePasser, scope);
  }
  check(ast, topScope);

  function assignToPattern(node, scope) {
    walk.recursive(node, null, {
      Expression: function(node) {
        check(node, scope);
      },
      VariablePattern: function(node) {
        var found = searchScope(node.name, scope);
        if (found) {
          found.written = true;
        } else if (!(node.name in ignoredGlobals)) {
          ignoredGlobals[node.name] = true;
          fail("Assignment to global variable " + node.name, node.loc);
        }
      }
    }, null, "Pattern");
  }

  function readFromPattern(node, scope) {
    walk.recursive(node, null, {
      Expression: function(node) {},
      VariablePattern: function(node) { readVariable(node, scope); }
    }, null, "Pattern");
  }

  function readVariable(node, scope) {
    var found = searchScope(node.name, scope);
    if (found) {
      found.read = true;
      if (found.deadZone && node.start < found.node.start && sameFunction(scope, found.deadZone))
        fail(found.type.charAt(0).toUpperCase() + found.type.slice(1) + " used before its declaration", node.loc);
    } else {
      globalsSeen[node.name] = node.loc;
    }
  }

  function exportDecl(decl, scope) {
    if (!decl) return;
    if (decl.id) {
      readVariable(decl.id, scope);
    } else if (decl.declarations) {
      for (var i = 0; i < decl.declarations.length; i++)
        readFromPattern(decl.declarations[i].id, scope);
    }
  }

  function sameFunction(inner, outer) {
    for (;;) {
      if (inner == outer) return true;
      if (inner.type == "fn") return false;
      inner = inner.prev;
    }
  }

  function searchScope(name, scope) {
    for (var cur = scope; cur; cur = cur.prev)
      if (name in cur.vars) return cur.vars[name];
  }

  function checkReusedIndex(node) {
    if (!node.init || node.init.type != "VariableDeclaration") return;
    var name = node.init.declarations[0].id.name;
    walk.recursive(node.body, null, {
      Function: function() {},
      VariableDeclaration: function(node, st, c) {
        for (var i = 0; i < node.declarations.length; i++)
          if (node.declarations[i].id.name == name)
            fail("Redefined loop variable", node.declarations[i].id.loc);
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

  if (m = text.match(/\/\/ declare global:\s+(.*)/))
    m[1].split(/,\s*/g).forEach(function(n) { allowedGlobals[n] = true; });
  for (var glob in globalsSeen)
    if (!(glob in allowedGlobals))
      fail("Access to global variable " + glob + ".", globalsSeen[glob]);

  for (var i = 0; i < scopes.length; ++i) {
    var scope = scopes[i];
    for (var name in scope.vars) {
      var info = scope.vars[name];
      if (!info.read) {
        if (info.type != "catch clause" && info.type != "function name" && name.charAt(0) != "_")
          fail("Unused " + info.type + " " + name, info.node.loc);
      } else if (!info.written) {
        fail(info.type.charAt(0).toUpperCase() + info.type.slice(1) + " " + name + " is never written to",
             info.node.loc);
      }
    }
  }

  function fail(msg, pos) {
    if (pos.start) msg += " (" + pos.start.line + ":" + pos.start.column + ")";
    if (options.message)
      options.message(pos.source, msg)
    else
      console["log"](pos.source + ": " + msg);
    failed = true;
  }
}

var failed = false;

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
