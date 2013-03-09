// Test page for Morbo

"use strict";

var flexo = require("flexo");

exports.PATTERNS = [
  [/^\/(index.html?)?$/, { GET: hello }]
];

function hello(tr) {
  tr.serve_html(tr.server.html_page({ title: "MORBO" },
    flexo.$$stylesheet("morbo.css"),
    flexo.$div({ "class": "hello-message" },
      flexo.$svg({ "class": "logo", viewBox: "-100 -100 200 200" },
        flexo.$g({ "stroke-linejoin": "round", "stroke-width": 16 },
          flexo.$poly({ sides: 7, phase: -90, r: 90, stroke: "black" }),
          flexo.$path({ d: "M-60,50L-30,-70L0,50L30,-70L60,50Z", fill: "#222",
            stroke: "#222" }))) +
      flexo.$p("Morbo is running.") +
      flexo.$p("Learn more about Morbo at ",
        flexo.$$a("https://github.com/julienq/morbo") + "."))));
}
