# Blint

Simple JavaScript linter.

```javascript
var blint = require("blint");
blint.checkFile("foo.js");
blint.checkDir("src");
```

When the linter encounters problems, it will write something to
stdout, and set a flag, which you can retrieve with `blint.success()`.

```javascript
process.exit(blint.success() ? 0 : 1);
```

Both `checkFile` and `checkDir` take a second optional options
argument. These are the defaults:

```javascript
var defaultOptions = {
  ecmaVersion: 5,
  browser: false,
  tabs: false,
  trailing: false,
  autoSemicolons: false,
  trailingCommas: false,
  reservedProps: false,
  declareGlobals: true,
  blob: false
};
```

Released under an MIT license.
