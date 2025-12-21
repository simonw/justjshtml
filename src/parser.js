import { Tokenizer, TokenizerOpts } from "./tokenizer.js";
import { TreeBuilder } from "./treebuilder.js";

export function parseDocument(html, options = {}) {
  const {
    fragmentContext = null,
    iframeSrcdoc = false,
    collectErrors = false,
    tokenizerOpts = null,
  } = options;

  const shouldCollect = Boolean(collectErrors);
  const treeBuilder = new TreeBuilder(fragmentContext, iframeSrcdoc, shouldCollect);

  const opts = tokenizerOpts instanceof TokenizerOpts ? tokenizerOpts : new TokenizerOpts(tokenizerOpts || {});

  // Match justhtml's fragment tokenizer state overrides.
  if (fragmentContext && !fragmentContext.namespace) {
    const tagName = (fragmentContext.tag_name || fragmentContext.tagName || "").toLowerCase();
    if (tagName === "textarea" || tagName === "title" || tagName === "style") {
      opts.initialState = Tokenizer.RAWTEXT;
      opts.initialRawtextTag = tagName;
    } else if (tagName === "plaintext" || tagName === "script") {
      opts.initialState = Tokenizer.PLAINTEXT;
      opts.initialRawtextTag = null;
    }
  }

  const tokenizer = new Tokenizer(treeBuilder, opts, { collectErrors: shouldCollect });
  treeBuilder.tokenizer = tokenizer;

  tokenizer.run(html || "");
  const root = treeBuilder.finish();
  const errors = [...tokenizer.errors, ...treeBuilder.errors];

  return { root, errors, tokenizer, treeBuilder };
}
