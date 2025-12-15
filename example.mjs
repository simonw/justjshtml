import { JustHTML, stream } from "./src/index.js";

const doc = new JustHTML("<p class='intro'>Hello <b>world</b></p>");

console.log(doc.toText()); // "Hello world"
console.log(doc.query("p.intro")[0].to_html()); // pretty-printed HTML for the matching node

for (const [event, data] of stream("<div>Hi</div>")) {
  console.log(event, data);
}
