// options={"semicolons": false}

for (var x = 1; x < 10; x++)
  ["foo", x]

let y = 10
(y += 1)

y += 1
;(y += 1)

if (y) {
  ;["bar", y]
}

100;

// ---
// Missing leading semicolon (4:2)
// Possibly accidentally continued statement (6:0)
// Semicolon found (16:0)
