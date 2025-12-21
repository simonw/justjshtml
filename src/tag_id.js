// Perfect hash-based tag identification
// This module provides O(1) tag name lookups using a minimal perfect hash function

// All known HTML tag names - each maps to a unique TagId
// The order determines the enum value
const ALL_TAGS = [
  // Special values
  "",           // UNKNOWN = 0

  // Structure tags
  "html", "head", "body", "template",

  // Head tags
  "title", "base", "basefont", "bgsound", "link", "meta", "style", "script", "noscript", "noframes",

  // Section tags
  "article", "aside", "footer", "header", "hgroup", "main", "nav", "section", "search",

  // Block tags
  "address", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset",
  "figcaption", "figure", "hr", "listing", "menu", "ol", "p", "pre", "summary", "ul",

  // Heading tags
  "h1", "h2", "h3", "h4", "h5", "h6",

  // List item tags
  "li", "dd", "dt",

  // Table tags
  "table", "caption", "colgroup", "col", "tbody", "thead", "tfoot", "tr", "td", "th",

  // Form tags
  "form", "button", "input", "select", "optgroup", "option", "textarea", "label", "keygen",

  // Formatting tags
  "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u",

  // Ruby tags
  "rb", "rp", "rt", "rtc", "ruby",

  // Void/self-closing tags
  "area", "br", "embed", "img", "param", "source", "track", "wbr",

  // Frame tags
  "frame", "frameset", "iframe",

  // Other tags
  "applet", "marquee", "object",
  "image",  // Misspelling that maps to img
  "math", "svg",
  "plaintext", "xmp", "noembed",
  "foreignobject", "desc", "annotation-xml",

  // Additional MathML text integration points
  "mi", "mo", "mn", "ms", "mtext",
];

// Build the tag name to ID mapping
const TAG_NAME_TO_ID = new Map();
for (let i = 0; i < ALL_TAGS.length; i++) {
  TAG_NAME_TO_ID.set(ALL_TAGS[i], i);
}

// Export TagId enum - frozen object with numeric values
export const TagId = Object.freeze(
  ALL_TAGS.reduce((acc, name, id) => {
    // Convert tag name to constant name: "h1" -> "H1", "annotation-xml" -> "ANNOTATION_XML"
    const constName = name.toUpperCase().replace(/-/g, "_") || "UNKNOWN";
    acc[constName] = id;
    return acc;
  }, {})
);

// Perfect hash function for tag name lookup
// Returns the TagId for a given lowercase tag name
export function getTagId(name) {
  return TAG_NAME_TO_ID.get(name) ?? TagId.UNKNOWN;
}

// Reverse lookup - get tag name from TagId
export function getTagName(id) {
  return ALL_TAGS[id] ?? "";
}

// ============================================================================
// Tag category bitmasks - allows O(1) category membership testing
// Each tag can belong to multiple categories via bitwise OR
// ============================================================================

// Category bits
export const TagCategory = Object.freeze({
  NONE:           0,
  VOID:           1 << 0,   // Self-closing elements
  FORMATTING:     1 << 1,   // Active formatting elements
  SPECIAL:        1 << 2,   // Special elements per HTML5 spec
  HEADING:        1 << 3,   // h1-h6
  SCOPE_DEFAULT:  1 << 4,   // Default scope terminators
  SCOPE_BUTTON:   1 << 5,   // Button scope terminators (includes default + button)
  SCOPE_LIST:     1 << 6,   // List item scope (includes default + ol, ul)
  SCOPE_TABLE:    1 << 7,   // Table scope terminators
  IMPLIED_END:    1 << 8,   // Implied end tags
  TABLE_FOSTER:   1 << 9,   // Table foster parenting targets
  FOREIGN_BREAK:  1 << 10,  // Foreign content breakout elements
  RAWTEXT:        1 << 11,  // RAWTEXT/RCDATA elements
  HEAD_ELEMENT:   1 << 12,  // Elements allowed in head
  TABLE_CHILD:    1 << 13,  // Allowed direct children of table
  EOF_UNCLOSED:   1 << 14,  // Elements that can be unclosed at EOF
  BLOCK_WITH_P:   1 << 15,  // Block elements that close P
  STRUCTURE_IGN:  1 << 16,  // Structure tags ignored in body
  APPLET_LIKE:    1 << 17,  // applet, marquee, object
  IN_HEAD_TAGS:   1 << 18,  // Tags processed in head mode
  FORMATTING_B:   1 << 19,  // Formatting elements handled by adoption agency
  TABLE_SECTION:  1 << 20,  // tbody, thead, tfoot
  TABLE_CELL:     1 << 21,  // td, th
  RUBY_TAGS:      1 << 22,  // rb, rp, rt, rtc
});

// Build category lookup table - maps TagId to category bitmask
const TAG_CATEGORIES = new Uint32Array(ALL_TAGS.length);

function addCategory(tags, category) {
  for (const tag of tags) {
    const id = getTagId(tag);
    if (id !== TagId.UNKNOWN) {
      TAG_CATEGORIES[id] |= category;
    }
  }
}

// Void elements
addCategory(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"], TagCategory.VOID);

// Formatting elements (for adoption agency)
addCategory(["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"], TagCategory.FORMATTING);

// Heading elements
addCategory(["h1", "h2", "h3", "h4", "h5", "h6"], TagCategory.HEADING);

// Default scope terminators
addCategory(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"], TagCategory.SCOPE_DEFAULT);

// Button scope = default scope + button
addCategory(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "button"], TagCategory.SCOPE_BUTTON);

// List item scope = default scope + ol, ul
addCategory(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "ol", "ul"], TagCategory.SCOPE_LIST);

// Table scope terminators
addCategory(["html", "table", "template"], TagCategory.SCOPE_TABLE);

// Implied end tags
addCategory(["dd", "dt", "li", "option", "optgroup", "p", "rb", "rp", "rt", "rtc"], TagCategory.IMPLIED_END);

// Table foster parenting targets
addCategory(["table", "tbody", "tfoot", "thead", "tr"], TagCategory.TABLE_FOSTER);

// Rawtext elements
addCategory(["script", "style", "xmp", "iframe", "noembed", "noframes", "textarea", "title"], TagCategory.RAWTEXT);

// Table section tags
addCategory(["tbody", "thead", "tfoot"], TagCategory.TABLE_SECTION);

// Table cell tags
addCategory(["td", "th"], TagCategory.TABLE_CELL);

// Ruby tags
addCategory(["rb", "rp", "rt", "rtc"], TagCategory.RUBY_TAGS);

// EOF allowed unclosed
addCategory([
  "dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc",
  "tbody", "td", "tfoot", "th", "thead", "tr", "body", "html"
], TagCategory.EOF_UNCLOSED);

// Block elements that close P
addCategory([
  "address", "article", "aside", "blockquote", "center", "details", "dialog",
  "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header",
  "hgroup", "listing", "main", "menu", "nav", "ol", "pre", "search", "section",
  "summary", "ul"
], TagCategory.BLOCK_WITH_P);

// Structure tags ignored in body
addCategory(["caption", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"], TagCategory.STRUCTURE_IGN);

// Applet-like elements
addCategory(["applet", "marquee", "object"], TagCategory.APPLET_LIKE);

// In-head tags (processed by modeInHead)
addCategory(["base", "basefont", "bgsound", "link", "meta", "template", "title", "style", "script", "noframes", "noscript"], TagCategory.IN_HEAD_TAGS);

// Table direct children
addCategory(["caption", "colgroup", "tbody", "tfoot", "thead", "tr", "td", "th", "script", "template", "style"], TagCategory.TABLE_CHILD);

// Special elements - this is a large set
addCategory([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound",
  "blockquote", "body", "br", "button", "caption", "center", "col", "colgroup",
  "dd", "details", "dialog", "dir", "div", "dl", "dt", "embed", "fieldset",
  "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2",
  "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "iframe",
  "img", "input", "keygen", "li", "link", "listing", "main", "marquee", "menu",
  "menuitem", "meta", "nav", "noembed", "noframes", "noscript", "object", "ol",
  "p", "param", "plaintext", "pre", "script", "search", "section", "select",
  "source", "style", "summary", "table", "tbody", "td", "template", "textarea",
  "tfoot", "th", "thead", "title", "tr", "track", "ul", "wbr"
], TagCategory.SPECIAL);

// Foreign content breakout elements
addCategory([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl",
  "dt", "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i",
  "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby",
  "s", "small", "span", "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var"
], TagCategory.FOREIGN_BREAK);

// Check if a tag has a specific category
export function hasCategory(tagId, category) {
  return (TAG_CATEGORIES[tagId] & category) !== 0;
}

// Check if a tag has any of the given categories
export function hasAnyCategory(tagId, categories) {
  return (TAG_CATEGORIES[tagId] & categories) !== 0;
}

// Check if a tag has all of the given categories
export function hasAllCategories(tagId, categories) {
  return (TAG_CATEGORIES[tagId] & categories) === categories;
}

// Get the full category bitmask for a tag
export function getCategories(tagId) {
  return TAG_CATEGORIES[tagId] ?? TagCategory.NONE;
}

// ============================================================================
// Convenience functions for common checks
// ============================================================================

export function isVoidElement(tagId) {
  return hasCategory(tagId, TagCategory.VOID);
}

export function isFormattingElement(tagId) {
  return hasCategory(tagId, TagCategory.FORMATTING);
}

export function isHeadingElement(tagId) {
  return hasCategory(tagId, TagCategory.HEADING);
}

export function isSpecialElement(tagId) {
  return hasCategory(tagId, TagCategory.SPECIAL);
}

export function isDefaultScopeTerminator(tagId) {
  return hasCategory(tagId, TagCategory.SCOPE_DEFAULT);
}

export function isImpliedEndTag(tagId) {
  return hasCategory(tagId, TagCategory.IMPLIED_END);
}

export function isTableSectionTag(tagId) {
  return hasCategory(tagId, TagCategory.TABLE_SECTION);
}

export function isTableCellTag(tagId) {
  return hasCategory(tagId, TagCategory.TABLE_CELL);
}

export function isRubyTag(tagId) {
  return hasCategory(tagId, TagCategory.RUBY_TAGS);
}

export function isEofAllowedUnclosed(tagId) {
  return hasCategory(tagId, TagCategory.EOF_UNCLOSED);
}

// ============================================================================
// Additional tag sets for specific insertion mode checks
// Uses arrays of TagIds for switch statement optimization
// ============================================================================

// Tags that trigger reprocess in BEFORE_HTML/BEFORE_HEAD modes for end tags
export const REPROCESS_END_TAGS = Object.freeze([
  TagId.HEAD, TagId.BODY, TagId.HTML, TagId.BR
]);

// Meta tags in head mode
export const HEAD_META_TAGS = Object.freeze([
  TagId.BASE, TagId.BASEFONT, TagId.BGSOUND, TagId.LINK, TagId.META
]);

// Text mode switch tags in head
export const HEAD_TEXT_TAGS = Object.freeze([
  TagId.TITLE, TagId.STYLE, TagId.SCRIPT, TagId.NOFRAMES
]);
