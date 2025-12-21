import {
  BUTTON_SCOPE_TERMINATORS,
  DEFAULT_SCOPE_TERMINATORS,
  DEFINITION_SCOPE_TERMINATORS,
  FOREIGN_ATTRIBUTE_ADJUSTMENTS,
  FOREIGN_BREAKOUT_ELEMENTS,
  FORMAT_MARKER,
  FORMATTING_ELEMENTS,
  HEADING_ELEMENTS,
  HTML_INTEGRATION_POINT_SET,
  IMPLIED_END_TAGS,
  LIST_ITEM_SCOPE_TERMINATORS,
  MATHML_ATTRIBUTE_ADJUSTMENTS,
  MATHML_TEXT_INTEGRATION_POINT_SET,
  SPECIAL_ELEMENTS,
  SVG_ATTRIBUTE_ADJUSTMENTS,
  SVG_TAG_NAME_ADJUSTMENTS,
  TABLE_ALLOWED_CHILDREN,
  TABLE_FOSTER_TARGETS,
  TABLE_SCOPE_TERMINATORS,
  integrationPointKey,
} from "./constants.js";
import { FragmentContext } from "./context.js";
import { Node } from "./node.js";
import { CharacterToken, CommentToken, DoctypeToken, EOFToken, ParseError, Tag, TokenSinkResult, Reprocess, TagId } from "./tokens.js";
import { InsertionMode, doctypeErrorAndQuirks, isAllWhitespace } from "./treebuilder_utils.js";
import {
  getTagId,
  hasCategory,
  TagCategory,
  isHeadingElement as isHeadingTagId,
  isFormattingElement as isFormattingTagId,
  isSpecialElement as isSpecialTagId,
  isEofAllowedUnclosed,
  isTableSectionTag,
  isTableCellTag,
  isRubyTag,
} from "./tag_id.js";

function lowerAscii(value) {
  return value ? String(value).toLowerCase() : "";
}

function isTemplateNode(node) {
  return node && node.name === "template" && node.templateContent;
}

// ---- Insertion mode handlers (incremental port) ---------------------------

function handleDoctype(self, token) {
  if (self.mode !== InsertionMode.INITIAL) {
    self._parse_error("unexpected-doctype");
    return TokenSinkResult.Continue;
  }

  const doctype = token.doctype;
  const [parseError, quirksMode] = doctypeErrorAndQuirks(doctype, { iframeSrcdoc: self.iframe_srcdoc });

  const node = new Node("!doctype", { data: doctype, namespace: null });
  self.document.append_child(node);

  if (parseError) self._parse_error("unknown-doctype");

  self._set_quirks_mode(quirksMode);
  self.mode = InsertionMode.BEFORE_HTML;
  return TokenSinkResult.Continue;
}

function modeInitial(self, token) {
  if (token instanceof CharacterToken) {
    if (isAllWhitespace(token.data)) return null;
    self._parse_error("expected-doctype-but-got-chars");
    self._set_quirks_mode("quirks");
    return new Reprocess(InsertionMode.BEFORE_HTML, token);
  }
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }
  if (token instanceof EOFToken) {
    self._parse_error("expected-doctype-but-got-eof");
    self._set_quirks_mode("quirks");
    self.mode = InsertionMode.BEFORE_HTML;
    return new Reprocess(InsertionMode.BEFORE_HTML, token);
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START) self._parse_error("expected-doctype-but-got-start-tag", token.name);
    else self._parse_error("expected-doctype-but-got-end-tag", token.name);
  }
  self._set_quirks_mode("quirks");
  return new Reprocess(InsertionMode.BEFORE_HTML, token);
}

function modeBeforeHtml(self, token) {
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return null;
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const tagId = token.tagId;
    if (token.kind === Tag.START) {
      if (tagId === TagId.HTML) {
        self._create_root(token.attrs);
        self.mode = InsertionMode.BEFORE_HEAD;
        return null;
      }
    } else {
      // End tag
      switch (tagId) {
        case TagId.HEAD:
        case TagId.BODY:
        case TagId.HTML:
        case TagId.BR:
          self._create_root({});
          self.mode = InsertionMode.BEFORE_HEAD;
          return new Reprocess(InsertionMode.BEFORE_HEAD, token);
        default:
          self._parse_error("unexpected-end-tag-before-html", token.name);
          return null;
      }
    }
  }

  if (token instanceof EOFToken) {
    self._create_root({});
    self.mode = InsertionMode.BEFORE_HEAD;
    return new Reprocess(InsertionMode.BEFORE_HEAD, token);
  }

  if (token instanceof CharacterToken) {
    const stripped = token.data.replace(/^[\t\n\f\r ]+/, "");
    if (stripped.length !== token.data.length) token = new CharacterToken(stripped);
  }

  self._create_root({});
  self.mode = InsertionMode.BEFORE_HEAD;
  return new Reprocess(InsertionMode.BEFORE_HEAD, token);
}

function modeBeforeHead(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint-before-head");
      data = data.replaceAll("\x00", "");
      if (!data) return null;
    }
    if (isAllWhitespace(data)) return null;
    token = new CharacterToken(data);
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const tagId = token.tagId;
    if (token.kind === Tag.START) {
      switch (tagId) {
        case TagId.HTML:
          self._add_missing_attributes(self.openElements[0], token.attrs);
          return null;
        case TagId.HEAD:
          self.head_element = self._insert_element(token, { push: true });
          self.mode = InsertionMode.IN_HEAD;
          return null;
      }
    } else {
      // End tag
      switch (tagId) {
        case TagId.HEAD:
        case TagId.BODY:
        case TagId.HTML:
        case TagId.BR:
          self.head_element = self._insert_phantom("head");
          self.mode = InsertionMode.IN_HEAD;
          return new Reprocess(InsertionMode.IN_HEAD, token);
        default:
          self._parse_error("unexpected-end-tag-before-head", token.name);
          return null;
      }
    }
  }

  if (token instanceof EOFToken) {
    self.head_element = self._insert_phantom("head");
    self.mode = InsertionMode.IN_HEAD;
    return new Reprocess(InsertionMode.IN_HEAD, token);
  }

  self.head_element = self._insert_phantom("head");
  self.mode = InsertionMode.IN_HEAD;
  return new Reprocess(InsertionMode.IN_HEAD, token);
}

function modeInHead(self, token) {
  if (token instanceof CharacterToken) {
    if (isAllWhitespace(token.data)) {
      self._append_text(token.data);
      return null;
    }

    const data = token.data || "";
    let i = 0;
    while (i < data.length) {
      const c = data[i];
      if (c !== "\t" && c !== "\n" && c !== "\f" && c !== "\r" && c !== " ") break;
      i += 1;
    }
    const leadingWs = data.slice(0, i);
    const remaining = data.slice(i);
    if (leadingWs) {
      const current = self.openElements.length ? self.openElements[self.openElements.length - 1] : null;
      if (current && current.has_child_nodes()) self._append_text(leadingWs);
    }
    self._pop_current();
    self.mode = InsertionMode.AFTER_HEAD;
    return new Reprocess(InsertionMode.AFTER_HEAD, new CharacterToken(remaining));
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const tagId = token.tagId;
    if (token.kind === Tag.START) {
      switch (tagId) {
        case TagId.HTML:
          self._pop_current();
          self.mode = InsertionMode.AFTER_HEAD;
          return new Reprocess(InsertionMode.AFTER_HEAD, token);
        case TagId.BASE:
        case TagId.BASEFONT:
        case TagId.BGSOUND:
        case TagId.LINK:
        case TagId.META:
          self._insert_element(token, { push: false });
          return null;
        case TagId.TEMPLATE:
          self._insert_element(token, { push: true });
          self._push_formatting_marker();
          self.frameset_ok = false;
          self.mode = InsertionMode.IN_TEMPLATE;
          self.template_modes.push(InsertionMode.IN_TEMPLATE);
          return null;
        case TagId.TITLE:
        case TagId.STYLE:
        case TagId.SCRIPT:
        case TagId.NOFRAMES:
          self._insert_element(token, { push: true });
          self.original_mode = self.mode;
          self.mode = InsertionMode.TEXT;
          return null;
        case TagId.NOSCRIPT:
          self._insert_element(token, { push: true });
          self.mode = InsertionMode.IN_HEAD_NOSCRIPT;
          return null;
      }
    } else {
      // End tag
      switch (tagId) {
        case TagId.TEMPLATE: {
          const hasTemplate = self.openElements.some((node) => node.name === "template");
          if (!hasTemplate) return null;
          self._generate_implied_end_tags();
          self._pop_until_inclusive("template");
          self._clear_active_formatting_up_to_marker();
          self.template_modes.pop();
          self._reset_insertion_mode();
          return null;
        }
        case TagId.HEAD:
          self._pop_current();
          self.mode = InsertionMode.AFTER_HEAD;
          return null;
        case TagId.BODY:
        case TagId.HTML:
        case TagId.BR:
          self._pop_current();
          self.mode = InsertionMode.AFTER_HEAD;
          return new Reprocess(InsertionMode.AFTER_HEAD, token);
      }
    }
  }

  if (token instanceof EOFToken) {
    self._pop_current();
    self.mode = InsertionMode.AFTER_HEAD;
    return new Reprocess(InsertionMode.AFTER_HEAD, token);
  }

  self._pop_current();
  self.mode = InsertionMode.AFTER_HEAD;
  return new Reprocess(InsertionMode.AFTER_HEAD, token);
}

function modeInHeadNoscript(self, token) {
  if (token instanceof CharacterToken) {
    const data = token.data || "";
    if (isAllWhitespace(data)) return modeInHead(self, token);
    self._parse_error("unexpected-start-tag", "text");
    self._pop_current();
    self.mode = InsertionMode.IN_HEAD;
    return new Reprocess(InsertionMode.IN_HEAD, token);
  }
  if (token instanceof CommentToken) return modeInHead(self, token);
  if (token instanceof Tag) {
    const tagId = token.tagId;
    if (token.kind === Tag.START) {
      switch (tagId) {
        case TagId.HTML:
          return modeInBody(self, token);
        case TagId.BASEFONT:
        case TagId.BGSOUND:
        case TagId.LINK:
        case TagId.META:
        case TagId.NOFRAMES:
        case TagId.STYLE:
          return modeInHead(self, token);
        case TagId.HEAD:
        case TagId.NOSCRIPT:
          self._parse_error("unexpected-start-tag", token.name);
          return null;
        default:
          self._parse_error("unexpected-start-tag", token.name);
          self._pop_current();
          self.mode = InsertionMode.IN_HEAD;
          return new Reprocess(InsertionMode.IN_HEAD, token);
      }
    }
    // End tag
    switch (tagId) {
      case TagId.NOSCRIPT:
        self._pop_current();
        self.mode = InsertionMode.IN_HEAD;
        return null;
      case TagId.BR:
        self._parse_error("unexpected-end-tag", token.name);
        self._pop_current();
        self.mode = InsertionMode.IN_HEAD;
        return new Reprocess(InsertionMode.IN_HEAD, token);
      default:
        self._parse_error("unexpected-end-tag", token.name);
        return null;
    }
  }
  if (token instanceof EOFToken) {
    self._parse_error("expected-closing-tag-but-got-eof", "noscript");
    self._pop_current();
    self.mode = InsertionMode.IN_HEAD;
    return new Reprocess(InsertionMode.IN_HEAD, token);
  }
  return null;
}

function modeAfterHead(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint-in-body");
      data = data.replaceAll("\x00", "");
    }
    if (data.includes("\x0c")) {
      self._parse_error("invalid-codepoint-in-body");
      data = data.replaceAll("\x0c", "");
    }
    if (!data || isAllWhitespace(data)) {
      if (data) self._append_text(data);
      return null;
    }
    self._insert_body_if_missing();
    return new Reprocess(InsertionMode.IN_BODY, new CharacterToken(data));
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const tagId = token.tagId;
    if (token.kind === Tag.START) {
      switch (tagId) {
        case TagId.HTML:
          self._insert_body_if_missing();
          return new Reprocess(InsertionMode.IN_BODY, token);
        case TagId.BODY:
          self._insert_element(token, { push: true });
          self.mode = InsertionMode.IN_BODY;
          self.frameset_ok = false;
          return null;
        case TagId.FRAMESET:
          self._insert_element(token, { push: true });
          self.mode = InsertionMode.IN_FRAMESET;
          return null;
        case TagId.INPUT: {
          let inputType = null;
          const attrs = token.attrs || {};
          for (const [name, value] of Object.entries(attrs)) {
            if (name === "type") {
              inputType = String(value || "").toLowerCase();
              break;
            }
          }
          if (inputType === "hidden") {
            self._parse_error("unexpected-hidden-input-after-head");
            return null;
          }
          self._insert_body_if_missing();
          return new Reprocess(InsertionMode.IN_BODY, token);
        }
        case TagId.BASE:
        case TagId.BASEFONT:
        case TagId.BGSOUND:
        case TagId.LINK:
        case TagId.META:
        case TagId.TITLE:
        case TagId.STYLE:
        case TagId.SCRIPT:
        case TagId.NOSCRIPT: {
          self.openElements.push(self.head_element);
          const result = modeInHead(self, token);
          const headIndex = self.openElements.indexOf(self.head_element);
          if (headIndex !== -1) self.openElements.splice(headIndex, 1);
          return result;
        }
        case TagId.TEMPLATE:
          self.openElements.push(self.head_element);
          self.mode = InsertionMode.IN_HEAD;
          return new Reprocess(InsertionMode.IN_HEAD, token);
      }
    } else {
      // End tag
      switch (tagId) {
        case TagId.TEMPLATE:
          return modeInHead(self, token);
        case TagId.BODY:
          self._insert_body_if_missing();
          return new Reprocess(InsertionMode.IN_BODY, token);
        case TagId.HTML:
        case TagId.BR:
          self._insert_body_if_missing();
          return new Reprocess(InsertionMode.IN_BODY, token);
        default:
          self._parse_error("unexpected-end-tag-after-head", token.name);
          return null;
      }
    }
  }

  if (token instanceof EOFToken) {
    self._insert_body_if_missing();
    self.mode = InsertionMode.IN_BODY;
    return new Reprocess(InsertionMode.IN_BODY, token);
  }

  self._insert_body_if_missing();
  return new Reprocess(InsertionMode.IN_BODY, token);
}

function modeText(self, token) {
  if (token instanceof CharacterToken) {
    self._append_text(token.data);
    return null;
  }
  if (token instanceof EOFToken) {
    const tagName = self.openElements.length ? self.openElements[self.openElements.length - 1].name : null;
    self._parse_error("expected-named-closing-tag-but-got-eof", tagName);
    self._pop_current();
    self.mode = self.original_mode || InsertionMode.IN_BODY;
    return ["reprocess", self.mode, token];
  }
  self._pop_current();
  self.mode = self.original_mode || InsertionMode.IN_BODY;
  return null;
}

const EOF_ALLOWED_UNCLOSED = new Set([
  "dd",
  "dt",
  "li",
  "optgroup",
  "option",
  "p",
  "rb",
  "rp",
  "rt",
  "rtc",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "body",
  "html",
]);

const SET_LI = new Set(["li"]);
const SET_DD = new Set(["dd"]);
const SET_DT = new Set(["dt"]);
const SET_DD_DT = new Set(["dd", "dt"]);
const SET_RB_RP_RT_RTC = new Set(["rb", "rp", "rt", "rtc"]);

function handleCharactersInBody(self, token) {
  let data = token.data || "";
  if (data.includes("\x00")) {
    self._parse_error("invalid-codepoint");
    data = data.replaceAll("\x00", "");
  }
  if (isAllWhitespace(data)) {
    self._reconstruct_active_formatting_elements();
    self._append_text(data);
    return null;
  }
  self._reconstruct_active_formatting_elements();
  self.frameset_ok = false;
  self._append_text(data);
  return null;
}

function handleCommentInBody(self, token) {
  self._append_comment(token.data);
  return null;
}

function handleBodyStartHtml(self, token) {
  if (self.template_modes.length) {
    self._parse_error("unexpected-start-tag", token.name);
    return null;
  }
  if (self.openElements.length) self._add_missing_attributes(self.openElements[0], token.attrs);
  return null;
}

function handleBodyStartBody(self, token) {
  if (self.template_modes.length) {
    self._parse_error("unexpected-start-tag", token.name);
    return null;
  }
  if (self.openElements.length > 1) {
    self._parse_error("unexpected-start-tag", token.name);
    const body = self.openElements.length > 1 ? self.openElements[1] : null;
    if (body && body.name === "body") self._add_missing_attributes(body, token.attrs);
    self.frameset_ok = false;
    return null;
  }
  self.frameset_ok = false;
  return null;
}

function handleBodyStartHead(self, token) {
  self._parse_error("unexpected-start-tag", token.name);
  return null;
}

function handleBodyStartInHead(self, token) {
  return modeInHead(self, token);
}

function handleBodyStartBlockWithP(self, token) {
  self._close_p_element();
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartHeading(self, token) {
  self._close_p_element();
  if (self.openElements.length && HEADING_ELEMENTS.has(self.openElements[self.openElements.length - 1].name)) {
    self._parse_error("unexpected-start-tag", token.name);
    self._pop_current();
  }
  self._insert_element(token, { push: true });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartPreListing(self, token) {
  self._close_p_element();
  self._insert_element(token, { push: true });
  self.ignore_lf = true;
  self.frameset_ok = false;
  return null;
}

function handleBodyStartForm(self, token) {
  if (self.form_element != null) {
    self._parse_error("unexpected-start-tag", token.name);
    return null;
  }
  self._close_p_element();
  const node = self._insert_element(token, { push: true });
  self.form_element = node;
  self.frameset_ok = false;
  return null;
}

function handleBodyStartButton(self, token) {
  if (self._has_in_scope("button")) {
    self._parse_error("unexpected-start-tag-implies-end-tag", token.name);
    self._close_element_by_name("button");
  }
  self._insert_element(token, { push: true });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartParagraph(self, token) {
  self._close_p_element();
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartMath(self, token) {
  self._reconstruct_active_formatting_elements();
  const attrs = self._prepare_foreign_attributes("math", token.attrs);
  const newTag = new Tag(Tag.START, token.name, attrs, token.selfClosing);
  self._insert_element(newTag, { push: !token.selfClosing, namespace: "math" });
  return null;
}

function handleBodyStartSvg(self, token) {
  self._reconstruct_active_formatting_elements();
  const adjustedName = self._adjust_svg_tag_name(token.name);
  const attrs = self._prepare_foreign_attributes("svg", token.attrs);
  const newTag = new Tag(Tag.START, adjustedName, attrs, token.selfClosing);
  self._insert_element(newTag, { push: !token.selfClosing, namespace: "svg" });
  return null;
}

function handleBodyStartLi(self, token) {
  self.frameset_ok = false;
  self._close_p_element();
  if (self._has_in_list_item_scope("li")) self._pop_until_any_inclusive(SET_LI);
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartDdDt(self, token) {
  self.frameset_ok = false;
  self._close_p_element();
  const name = token.name;
  if (name === "dd") {
    if (self._has_in_definition_scope("dd")) self._pop_until_any_inclusive(SET_DD);
    if (self._has_in_definition_scope("dt")) self._pop_until_any_inclusive(SET_DT);
  } else {
    if (self._has_in_definition_scope("dt")) self._pop_until_any_inclusive(SET_DT);
    if (self._has_in_definition_scope("dd")) self._pop_until_any_inclusive(SET_DD);
  }
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartA(self, token) {
  if (self._has_active_formatting_entry("a")) {
    self._adoption_agency("a");
    self._remove_last_active_formatting_by_name("a");
    self._remove_last_open_element_by_name("a");
  }
  self._reconstruct_active_formatting_elements();
  const node = self._insert_element(token, { push: true });
  self._append_active_formatting_entry("a", token.attrs, node);
  return null;
}

function handleBodyStartFormatting(self, token) {
  const name = token.name;
  if (name === "nobr" && self._in_scope("nobr")) {
    self._adoption_agency("nobr");
    self._remove_last_active_formatting_by_name("nobr");
    self._remove_last_open_element_by_name("nobr");
  }
  self._reconstruct_active_formatting_elements();
  const dupIndex = self._find_active_formatting_duplicate(name, token.attrs);
  if (dupIndex != null) self._remove_formatting_entry(dupIndex);
  const node = self._insert_element(token, { push: true });
  self._append_active_formatting_entry(name, token.attrs, node);
  return null;
}

function handleBodyStartAppletLike(self, token) {
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: true });
  self._push_formatting_marker();
  self.frameset_ok = false;
  return null;
}

function handleBodyStartBr(self, token) {
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: false });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartHr(self, token) {
  self._close_p_element();
  self._insert_element(token, { push: false });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartFrameset(self, token) {
  if (!self.frameset_ok) {
    self._parse_error("unexpected-start-tag-ignored", token.name);
    return null;
  }

  let bodyIndex = null;
  for (let i = 0; i < self.openElements.length; i += 1) {
    if (self.openElements[i].name === "body") {
      bodyIndex = i;
      break;
    }
  }
  if (bodyIndex == null) {
    self._parse_error("unexpected-start-tag-ignored", token.name);
    return null;
  }

  const bodyElem = self.openElements[bodyIndex];
  if (bodyElem.parent) bodyElem.parent.remove_child(bodyElem);
  self.openElements.length = bodyIndex;

  self._insert_element(token, { push: true });
  self.mode = InsertionMode.IN_FRAMESET;
  return null;
}

function handleBodyStartStructureIgnored(self, token) {
  self._parse_error("unexpected-start-tag-ignored", token.name);
  return null;
}

function handleBodyStartColOrFrame(self, token) {
  if (self.fragment_context == null) {
    self._parse_error("unexpected-start-tag-ignored", token.name);
    return null;
  }
  self._insert_element(token, { push: false });
  return null;
}

function handleBodyStartImage(self, token) {
  self._parse_error("image-start-tag", token.name);
  const imgToken = new Tag(Tag.START, "img", token.attrs, token.selfClosing);
  self._reconstruct_active_formatting_elements();
  self._insert_element(imgToken, { push: false });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartVoidWithFormatting(self, token) {
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: false });
  self.frameset_ok = false;
  return null;
}

function handleBodyStartSimpleVoid(self, token) {
  self._insert_element(token, { push: false });
  return null;
}

function handleBodyStartInput(self, token) {
  let inputType = null;
  const attrs = token.attrs || {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "type") {
      inputType = String(value || "").toLowerCase();
      break;
    }
  }
  self._insert_element(token, { push: false });
  if (inputType !== "hidden") self.frameset_ok = false;
  return null;
}

function handleBodyStartTable(self, token) {
  if (self.quirks_mode !== "quirks") self._close_p_element();
  self._insert_element(token, { push: true });
  self.frameset_ok = false;
  self.mode = InsertionMode.IN_TABLE;
  return null;
}

function handleBodyStartPlaintextXmp(self, token) {
  self._close_p_element();
  self._insert_element(token, { push: true });
  self.frameset_ok = false;
  if (token.name === "plaintext") {
    self.tokenizer_state_override = TokenSinkResult.Plaintext;
  } else {
    self.original_mode = self.mode;
    self.mode = InsertionMode.TEXT;
  }
  return null;
}

function handleBodyStartTextarea(self, token) {
  self._insert_element(token, { push: true });
  self.ignore_lf = true;
  self.frameset_ok = false;
  return null;
}

function handleBodyStartSelect(self, token) {
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: true });
  self.frameset_ok = false;
  self._reset_insertion_mode();
  return null;
}

function handleBodyStartOption(self, token) {
  if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
    self.openElements.pop();
  }
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartOptgroup(self, token) {
  if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
    self.openElements.pop();
  }
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartRpRt(self, token) {
  self._generate_implied_end_tags("rtc");
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartRbRtc(self, token) {
  if (self.openElements.length && SET_RB_RP_RT_RTC.has(self.openElements[self.openElements.length - 1].name)) {
    self._generate_implied_end_tags();
  }
  self._insert_element(token, { push: true });
  return null;
}

function handleBodyStartTableParseError(self, token) {
  self._parse_error("unexpected-start-tag", token.name);
  return null;
}

function handleBodyStartDefault(self, token) {
  self._reconstruct_active_formatting_elements();
  self._insert_element(token, { push: true });
  if (token.selfClosing) self._parse_error("non-void-html-element-start-tag-with-trailing-solidus", token.name);
  self.frameset_ok = false;
  return null;
}

const BODY_START_HANDLERS = {
  a: handleBodyStartA,
  address: handleBodyStartBlockWithP,
  applet: handleBodyStartAppletLike,
  area: handleBodyStartVoidWithFormatting,
  article: handleBodyStartBlockWithP,
  aside: handleBodyStartBlockWithP,
  b: handleBodyStartFormatting,
  base: handleBodyStartInHead,
  basefont: handleBodyStartInHead,
  bgsound: handleBodyStartInHead,
  big: handleBodyStartFormatting,
  blockquote: handleBodyStartBlockWithP,
  body: handleBodyStartBody,
  br: handleBodyStartBr,
  button: handleBodyStartButton,
  caption: handleBodyStartTableParseError,
  center: handleBodyStartBlockWithP,
  code: handleBodyStartFormatting,
  col: handleBodyStartColOrFrame,
  colgroup: handleBodyStartStructureIgnored,
  dd: handleBodyStartDdDt,
  details: handleBodyStartBlockWithP,
  dialog: handleBodyStartBlockWithP,
  dir: handleBodyStartBlockWithP,
  div: handleBodyStartBlockWithP,
  dl: handleBodyStartBlockWithP,
  dt: handleBodyStartDdDt,
  em: handleBodyStartFormatting,
  embed: handleBodyStartVoidWithFormatting,
  fieldset: handleBodyStartBlockWithP,
  figcaption: handleBodyStartBlockWithP,
  figure: handleBodyStartBlockWithP,
  font: handleBodyStartFormatting,
  footer: handleBodyStartBlockWithP,
  form: handleBodyStartForm,
  frame: handleBodyStartColOrFrame,
  frameset: handleBodyStartFrameset,
  h1: handleBodyStartHeading,
  h2: handleBodyStartHeading,
  h3: handleBodyStartHeading,
  h4: handleBodyStartHeading,
  h5: handleBodyStartHeading,
  h6: handleBodyStartHeading,
  head: handleBodyStartHead,
  header: handleBodyStartBlockWithP,
  hgroup: handleBodyStartBlockWithP,
  hr: handleBodyStartHr,
  html: handleBodyStartHtml,
  i: handleBodyStartFormatting,
  image: handleBodyStartImage,
  img: handleBodyStartVoidWithFormatting,
  input: handleBodyStartInput,
  keygen: handleBodyStartVoidWithFormatting,
  li: handleBodyStartLi,
  link: handleBodyStartInHead,
  listing: handleBodyStartPreListing,
  main: handleBodyStartBlockWithP,
  marquee: handleBodyStartAppletLike,
  math: handleBodyStartMath,
  menu: handleBodyStartBlockWithP,
  meta: handleBodyStartInHead,
  nav: handleBodyStartBlockWithP,
  nobr: handleBodyStartFormatting,
  noframes: handleBodyStartInHead,
  object: handleBodyStartAppletLike,
  ol: handleBodyStartBlockWithP,
  optgroup: handleBodyStartOptgroup,
  option: handleBodyStartOption,
  p: handleBodyStartParagraph,
  param: handleBodyStartSimpleVoid,
  plaintext: handleBodyStartPlaintextXmp,
  pre: handleBodyStartPreListing,
  rb: handleBodyStartRbRtc,
  rp: handleBodyStartRpRt,
  rt: handleBodyStartRpRt,
  rtc: handleBodyStartRbRtc,
  s: handleBodyStartFormatting,
  script: handleBodyStartInHead,
  search: handleBodyStartBlockWithP,
  section: handleBodyStartBlockWithP,
  select: handleBodyStartSelect,
  small: handleBodyStartFormatting,
  source: handleBodyStartSimpleVoid,
  strike: handleBodyStartFormatting,
  strong: handleBodyStartFormatting,
  style: handleBodyStartInHead,
  summary: handleBodyStartBlockWithP,
  svg: handleBodyStartSvg,
  table: handleBodyStartTable,
  tbody: handleBodyStartStructureIgnored,
  td: handleBodyStartStructureIgnored,
  template: handleBodyStartInHead,
  textarea: handleBodyStartTextarea,
  tfoot: handleBodyStartStructureIgnored,
  th: handleBodyStartStructureIgnored,
  thead: handleBodyStartStructureIgnored,
  title: handleBodyStartInHead,
  tr: handleBodyStartStructureIgnored,
  track: handleBodyStartSimpleVoid,
  tt: handleBodyStartFormatting,
  u: handleBodyStartFormatting,
  ul: handleBodyStartBlockWithP,
  wbr: handleBodyStartVoidWithFormatting,
  xmp: handleBodyStartPlaintextXmp,
};

function handleBodyEndBody(self, token) {
  if (self._in_scope("body")) self.mode = InsertionMode.AFTER_BODY;
  return null;
}

function handleBodyEndHtml(self, token) {
  if (self._in_scope("body")) return ["reprocess", InsertionMode.AFTER_BODY, token];
  return null;
}

function handleBodyEndP(self, token) {
  if (!self._close_p_element()) {
    self._parse_error("unexpected-end-tag", token.name);
    const phantom = new Tag(Tag.START, "p", {}, false);
    self._insert_element(phantom, { push: true });
    self._close_p_element();
  }
  return null;
}

function handleBodyEndLi(self, token) {
  if (!self._has_in_list_item_scope("li")) {
    self._parse_error("unexpected-end-tag", token.name);
    return null;
  }
  self._pop_until_any_inclusive(SET_LI);
  return null;
}

function handleBodyEndDdDt(self, token) {
  const name = token.name;
  if (!self._has_in_definition_scope(name)) {
    self._parse_error("unexpected-end-tag", name);
    return null;
  }
  self._pop_until_any_inclusive(SET_DD_DT);
  return null;
}

function handleBodyEndForm(self, token) {
  if (self.form_element == null) {
    self._parse_error("unexpected-end-tag", token.name);
    return null;
  }
  const removed = self._remove_from_openElements(self.form_element);
  self.form_element = null;
  if (!removed) self._parse_error("unexpected-end-tag", token.name);
  return null;
}

function handleBodyEndAppletLike(self, token) {
  const name = token.name;
  if (!self._in_scope(name)) {
    self._parse_error("unexpected-end-tag", name);
    return null;
  }
  while (self.openElements.length) {
    const popped = self.openElements.pop();
    if (popped.name === name) break;
  }
  self._clear_active_formatting_up_to_marker();
  return null;
}

function handleBodyEndHeading(self, token) {
  const name = token.name;
  if (!self._has_any_in_scope(HEADING_ELEMENTS)) {
    self._parse_error("unexpected-end-tag", name);
    return null;
  }
  self._generate_implied_end_tags();
  if (self.openElements.length && self.openElements[self.openElements.length - 1].name !== name) {
    self._parse_error("end-tag-too-early", name);
  }
  while (self.openElements.length) {
    const popped = self.openElements.pop();
    if (HEADING_ELEMENTS.has(popped.name)) break;
  }
  return null;
}

function handleBodyEndBlock(self, token) {
  const name = token.name;
  if (!self._in_scope(name)) {
    self._parse_error("unexpected-end-tag", name);
    return null;
  }
  self._generate_implied_end_tags();
  if (self.openElements.length && self.openElements[self.openElements.length - 1].name !== name) {
    self._parse_error("end-tag-too-early", name);
  }
  self._pop_until_any_inclusive(new Set([name]));
  return null;
}

function handleBodyEndTemplate(self, token) {
  const hasTemplate = self.openElements.some((node) => node.name === "template");
  if (!hasTemplate) return null;
  self._generate_implied_end_tags();
  self._pop_until_inclusive("template");
  self._clear_active_formatting_up_to_marker();
  if (self.template_modes.length) self.template_modes.pop();
  self._reset_insertion_mode();
  return null;
}

const BODY_END_HANDLERS = {
  address: handleBodyEndBlock,
  applet: handleBodyEndAppletLike,
  article: handleBodyEndBlock,
  aside: handleBodyEndBlock,
  blockquote: handleBodyEndBlock,
  body: handleBodyEndBody,
  button: handleBodyEndBlock,
  center: handleBodyEndBlock,
  dd: handleBodyEndDdDt,
  details: handleBodyEndBlock,
  dialog: handleBodyEndBlock,
  dir: handleBodyEndBlock,
  div: handleBodyEndBlock,
  dl: handleBodyEndBlock,
  dt: handleBodyEndDdDt,
  fieldset: handleBodyEndBlock,
  figcaption: handleBodyEndBlock,
  figure: handleBodyEndBlock,
  footer: handleBodyEndBlock,
  form: handleBodyEndForm,
  h1: handleBodyEndHeading,
  h2: handleBodyEndHeading,
  h3: handleBodyEndHeading,
  h4: handleBodyEndHeading,
  h5: handleBodyEndHeading,
  h6: handleBodyEndHeading,
  header: handleBodyEndBlock,
  hgroup: handleBodyEndBlock,
  html: handleBodyEndHtml,
  li: handleBodyEndLi,
  listing: handleBodyEndBlock,
  main: handleBodyEndBlock,
  marquee: handleBodyEndAppletLike,
  menu: handleBodyEndBlock,
  nav: handleBodyEndBlock,
  object: handleBodyEndAppletLike,
  ol: handleBodyEndBlock,
  p: handleBodyEndP,
  pre: handleBodyEndBlock,
  search: handleBodyEndBlock,
  section: handleBodyEndBlock,
  summary: handleBodyEndBlock,
  table: handleBodyEndBlock,
  template: handleBodyEndTemplate,
  ul: handleBodyEndBlock,
};

function handleTagInBody(self, token) {
  const name = token.name;
  if (token.kind === Tag.START) {
    const handler = BODY_START_HANDLERS[name];
    if (handler) return handler(self, token);
    return handleBodyStartDefault(self, token);
  }

  // End tag
  const tagId = token.tagId;
  if (tagId === TagId.BR) {
    self._parse_error("unexpected-end-tag", name);
    const brTag = new Tag(Tag.START, "br", {}, false, TagId.BR);
    return modeInBody(self, brTag);
  }

  if (isFormattingTagId(tagId)) {
    self._adoption_agency(name);
    return null;
  }

  const handler = BODY_END_HANDLERS[name];
  if (handler) return handler(self, token);

  self._any_other_end_tag(name);
  return null;
}

function handleEofInBody(self, token) {
  if (self.template_modes.length) return modeInTemplate(self, token);

  for (const node of self.openElements) {
    const nodeTagId = node.tagId ?? getTagId(node.name);
    if (!isEofAllowedUnclosed(nodeTagId)) {
      self._parse_error("expected-closing-tag-but-got-eof", node.name);
      break;
    }
  }

  self.mode = InsertionMode.AFTER_BODY;
  return new Reprocess(InsertionMode.AFTER_BODY, token);
}

function modeInBody(self, token) {
  if (token instanceof CharacterToken) return handleCharactersInBody(self, token);
  if (token instanceof CommentToken) return handleCommentInBody(self, token);
  if (token instanceof Tag) return handleTagInBody(self, token);
  if (token instanceof EOFToken) return handleEofInBody(self, token);
  return null;
}

function modeAfterBody(self, token) {
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return modeInBody(self, token);
  if (token instanceof CommentToken) {
    const html = self.openElements.length ? self.openElements[0] : null;
    self._append_comment(token.data, html || undefined);
    return null;
  }
  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") return modeInBody(self, token);
    if (token.kind === Tag.END && token.name === "html") {
      self.mode = InsertionMode.AFTER_AFTER_BODY;
      return null;
    }
  }
  if (token instanceof EOFToken) return null;
  self._parse_error("unexpected-token-after-body");
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
}

function modeAfterAfterBody(self, token) {
  if (token instanceof CommentToken) {
    if (self.fragment_context != null) {
      const html = self._find_last_on_stack("html");
      if (html) self._append_comment(token.data, html);
      else self._append_comment_to_document(token.data);
      return null;
    }
    self._append_comment_to_document(token.data);
    return null;
  }
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return modeInBody(self, token);
  if (token instanceof Tag && token.kind === Tag.START && token.name === "html") return modeInBody(self, token);
  if (token instanceof EOFToken) return null;
  self._parse_error("unexpected-token-after-after-body");
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
}

const TABLE_BODY_CONTEXT_TAGS = new Set(["tbody", "tfoot", "thead"]);
const TABLE_BODY_CONTEXT_CLEAR_UNTIL = new Set(["tbody", "tfoot", "thead", "template", "html"]);
const TABLE_ROW_CONTEXT_CLEAR_UNTIL = new Set(["tr", "template", "html"]);
const TABLE_CONTEXT_CLEAR_UNTIL = new Set(["table", "template", "html"]);

const TABLE_MODE_TABLE_VOODOO_END_TAGS = new Set([
  "body",
  "caption",
  "col",
  "colgroup",
  "html",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

function modeInTable(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("unexpected-null-character");
      data = data.replaceAll("\x00", "");
      if (!data) return null;
      token = new CharacterToken(data);
    }

    self.pending_table_text.length = 0;
    self.table_text_original_mode = self.mode;
    self.mode = InsertionMode.IN_TABLE_TEXT;
    return ["reprocess", InsertionMode.IN_TABLE_TEXT, token];
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (name === "caption") {
        self._clear_stack_until(TABLE_CONTEXT_CLEAR_UNTIL);
        self._push_formatting_marker();
        self._insert_element(token, { push: true });
        self.mode = InsertionMode.IN_CAPTION;
        return null;
      }
      if (name === "colgroup") {
        self._clear_stack_until(TABLE_CONTEXT_CLEAR_UNTIL);
        self._insert_element(token, { push: true });
        self.mode = InsertionMode.IN_COLUMN_GROUP;
        return null;
      }
      if (name === "col") {
        self._clear_stack_until(TABLE_CONTEXT_CLEAR_UNTIL);
        const implied = new Tag(Tag.START, "colgroup", {}, false);
        self._insert_element(implied, { push: true });
        self.mode = InsertionMode.IN_COLUMN_GROUP;
        return ["reprocess", InsertionMode.IN_COLUMN_GROUP, token];
      }
      if (name === "tbody" || name === "tfoot" || name === "thead") {
        self._clear_stack_until(TABLE_CONTEXT_CLEAR_UNTIL);
        self._insert_element(token, { push: true });
        self.mode = InsertionMode.IN_TABLE_BODY;
        return null;
      }
      if (name === "td" || name === "th" || name === "tr") {
        self._clear_stack_until(TABLE_CONTEXT_CLEAR_UNTIL);
        const implied = new Tag(Tag.START, "tbody", {}, false);
        self._insert_element(implied, { push: true });
        self.mode = InsertionMode.IN_TABLE_BODY;
        return ["reprocess", InsertionMode.IN_TABLE_BODY, token];
      }
      if (name === "table") {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        const closed = self._close_table_element();
        if (closed) return ["reprocess", self.mode, token];
        return null;
      }
      if (name === "style" || name === "script") {
        self._insert_element(token, { push: true });
        self.original_mode = self.mode;
        self.mode = InsertionMode.TEXT;
        return null;
      }
      if (name === "template") {
        return modeInHead(self, token);
      }
      if (name === "input") {
        let inputType = null;
        const attrs = token.attrs || {};
        for (const [attrName, attrValue] of Object.entries(attrs)) {
          if (attrName === "type") {
            inputType = String(attrValue || "").toLowerCase();
            break;
          }
        }
        if (inputType === "hidden") {
          self._parse_error("unexpected-hidden-input-in-table");
          self._insert_element(token, { push: true });
          self.openElements.pop();
          return null;
        }
      }
      if (name === "form") {
        self._parse_error("unexpected-form-in-table");
        if (self.form_element == null) {
          const node = self._insert_element(token, { push: true });
          self.form_element = node;
          self.openElements.pop();
        }
        return null;
      }

      self._parse_error("unexpected-start-tag-implies-table-voodoo", name);
      const previous = self.insert_from_table;
      self.insert_from_table = true;
      try {
        return modeInBody(self, token);
      } finally {
        self.insert_from_table = previous;
      }
    }

    // End tag.
    if (name === "table") {
      self._close_table_element();
      return null;
    }
    if (TABLE_MODE_TABLE_VOODOO_END_TAGS.has(name)) {
      self._parse_error("unexpected-end-tag", name);
      return null;
    }

    self._parse_error("unexpected-end-tag-implies-table-voodoo", name);
    const previous = self.insert_from_table;
    self.insert_from_table = true;
    try {
      return modeInBody(self, token);
    } finally {
      self.insert_from_table = previous;
    }
  }

  if (token instanceof EOFToken) {
    if (self.template_modes.length) return modeInTemplate(self, token);
    if (self._has_in_table_scope("table")) self._parse_error("expected-closing-tag-but-got-eof", "table");
    return null;
  }

  return null;
}

function modeInTableText(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data;
    if (data.includes("\x0c")) {
      self._parse_error("invalid-codepoint-in-table-text");
      data = data.replaceAll("\x0c", "");
    }
    if (data) self.pending_table_text.push(data);
    return null;
  }

  self._flush_pending_table_text();
  const original = self.table_text_original_mode ?? InsertionMode.IN_TABLE;
  self.table_text_original_mode = null;
  self.mode = original;
  return ["reprocess", original, token];
}

const CAPTION_STRUCTURE_START_TAGS = new Set(["caption", "col", "colgroup", "tbody", "tfoot", "thead", "tr", "td", "th"]);
const CAPTION_END_TAGS_NEVER_IN_SCOPE = new Set(["tbody", "tfoot", "thead"]);

function modeInCaption(self, token) {
  if (token instanceof CharacterToken) return modeInBody(self, token);
  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (CAPTION_STRUCTURE_START_TAGS.has(name)) {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        if (self._close_caption_element()) return ["reprocess", InsertionMode.IN_TABLE, token];
        return null;
      }
      if (name === "table") {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        if (self._close_caption_element()) return ["reprocess", InsertionMode.IN_TABLE, token];
        return modeInBody(self, token);
      }
      return modeInBody(self, token);
    }

    // End tag.
    if (name === "caption") {
      self._close_caption_element();
      return null;
    }
    if (name === "table") {
      if (self._close_caption_element()) return ["reprocess", InsertionMode.IN_TABLE, token];
      return null;
    }
    if (CAPTION_END_TAGS_NEVER_IN_SCOPE.has(name)) {
      self._parse_error("unexpected-end-tag", name);
      return null;
    }
    return modeInBody(self, token);
  }

  if (token instanceof EOFToken) return modeInBody(self, token);
  return null;
}

function modeInColumnGroup(self, token) {
  const current = self.openElements.length ? self.openElements[self.openElements.length - 1] : null;

  if (token instanceof CharacterToken) {
    const data = token.data || "";
    let i = 0;
    while (i < data.length && "\t\n\f\r ".includes(data[i])) i += 1;

    if (i) self._append_text(data.slice(0, i));
    const rest = data.slice(i);
    if (!rest) return null;

    if (current && current.name === "html") {
      self._parse_error("unexpected-characters-in-column-group");
      return null;
    }
    if (current && current.name === "template") {
      self._parse_error("unexpected-characters-in-template-column-group");
      return null;
    }

    self._parse_error("unexpected-characters-in-column-group");
    self._pop_current();
    self.mode = InsertionMode.IN_TABLE;
    return ["reprocess", InsertionMode.IN_TABLE, new CharacterToken(rest)];
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (name === "html") return modeInBody(self, token);
      if (name === "col") {
        self._insert_element(token, { push: true });
        self.openElements.pop();
        return null;
      }
      if (name === "template") return modeInHead(self, token);
      if (name === "colgroup") {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        if (current && current.name === "colgroup") {
          self._pop_current();
          self.mode = InsertionMode.IN_TABLE;
          return ["reprocess", InsertionMode.IN_TABLE, token];
        }
        return null;
      }

      if (
        self.fragment_context &&
        (self.fragment_context.tag_name || self.fragment_context.tagName || "").toLowerCase() === "colgroup" &&
        !self._has_in_table_scope("table")
      ) {
        self._parse_error("unexpected-start-tag-in-column-group", name);
        return null;
      }

      if (current && current.name === "colgroup") {
        self._pop_current();
        self.mode = InsertionMode.IN_TABLE;
        return ["reprocess", InsertionMode.IN_TABLE, token];
      }

      self._parse_error("unexpected-start-tag-in-template-column-group", name);
      return null;
    }

    // End tag.
    if (name === "colgroup") {
      if (current && current.name === "colgroup") {
        self._pop_current();
        self.mode = InsertionMode.IN_TABLE;
      } else {
        self._parse_error("unexpected-end-tag", name);
      }
      return null;
    }
    if (name === "col") {
      self._parse_error("unexpected-end-tag", name);
      return null;
    }
    if (name === "template") {
      return modeInHead(self, token);
    }

    if (current && current.name !== "html") {
      self._pop_current();
      self.mode = InsertionMode.IN_TABLE;
    }
    return ["reprocess", InsertionMode.IN_TABLE, token];
  }

  if (token instanceof EOFToken) {
    if (current && current.name === "colgroup") {
      self._pop_current();
      self.mode = InsertionMode.IN_TABLE;
      return ["reprocess", InsertionMode.IN_TABLE, token];
    }
    if (current && current.name === "template") return modeInTemplate(self, token);
    return null;
  }

  return null;
}

const TABLE_BODY_EXIT_START_TAGS = new Set(["caption", "col", "colgroup", "tbody", "tfoot", "thead", "table"]);
const TABLE_BODY_UNEXPECTED_END_TAGS = new Set(["caption", "col", "colgroup", "td", "th", "tr"]);

function modeInTableBody(self, token) {
  if (token instanceof CharacterToken || token instanceof CommentToken) return modeInTable(self, token);

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (name === "tr") {
        self._clear_stack_until(TABLE_BODY_CONTEXT_CLEAR_UNTIL);
        self._insert_element(token, { push: true });
        self.mode = InsertionMode.IN_ROW;
        return null;
      }
      if (name === "td" || name === "th") {
        self._parse_error("unexpected-cell-in-table-body");
        self._clear_stack_until(TABLE_BODY_CONTEXT_CLEAR_UNTIL);
        const implied = new Tag(Tag.START, "tr", {}, false);
        self._insert_element(implied, { push: true });
        self.mode = InsertionMode.IN_ROW;
        return ["reprocess", InsertionMode.IN_ROW, token];
      }

      if (TABLE_BODY_EXIT_START_TAGS.has(name)) {
        const current = self.openElements.length ? self.openElements[self.openElements.length - 1] : null;
        if (current && current.name === "template") {
          self._parse_error("unexpected-start-tag-in-template-table-context", name);
          return null;
        }
        if (
          self.fragment_context &&
          current &&
          current.name === "html" &&
          TABLE_BODY_CONTEXT_TAGS.has((self.fragment_context.tag_name || self.fragment_context.tagName || "").toLowerCase())
        ) {
          self._parse_error("unexpected-start-tag");
          return null;
        }
        if (self.openElements.length) {
          self.openElements.pop();
          self.mode = InsertionMode.IN_TABLE;
          return ["reprocess", InsertionMode.IN_TABLE, token];
        }
        self.mode = InsertionMode.IN_TABLE;
        return null;
      }

      return modeInTable(self, token);
    }

    if (name === "tbody" || name === "tfoot" || name === "thead") {
      if (!self._has_in_table_scope(name)) {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      self._clear_stack_until(TABLE_BODY_CONTEXT_CLEAR_UNTIL);
      self._pop_current();
      self.mode = InsertionMode.IN_TABLE;
      return null;
    }

    if (name === "table") {
      const current = self.openElements.length ? self.openElements[self.openElements.length - 1] : null;
      if (current && current.name === "template") {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      if (
        self.fragment_context &&
        current &&
        current.name === "html" &&
        TABLE_BODY_CONTEXT_TAGS.has((self.fragment_context.tag_name || self.fragment_context.tagName || "").toLowerCase())
      ) {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      if (current && TABLE_BODY_CONTEXT_TAGS.has(current.name)) self.openElements.pop();
      self.mode = InsertionMode.IN_TABLE;
      return ["reprocess", InsertionMode.IN_TABLE, token];
    }

    if (TABLE_BODY_UNEXPECTED_END_TAGS.has(name)) {
      self._parse_error("unexpected-end-tag", name);
      return null;
    }

    return modeInTable(self, token);
  }

  if (token instanceof EOFToken) return modeInTable(self, token);
  return null;
}

const ROW_TABLE_EXIT_START_TAGS = new Set(["caption", "col", "colgroup", "tbody", "tfoot", "thead", "tr", "table"]);
const ROW_UNEXPECTED_END_TAGS = new Set(["caption", "col", "group", "td", "th"]);

function modeInRow(self, token) {
  if (token instanceof CharacterToken || token instanceof CommentToken) return modeInTable(self, token);

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (name === "td" || name === "th") {
        self._clear_stack_until(TABLE_ROW_CONTEXT_CLEAR_UNTIL);
        self._insert_element(token, { push: true });
        self._push_formatting_marker();
        self.mode = InsertionMode.IN_CELL;
        return null;
      }
      if (ROW_TABLE_EXIT_START_TAGS.has(name)) {
        if (!self._has_in_table_scope("tr")) {
          self._parse_error("unexpected-start-tag-implies-end-tag", name);
          return null;
        }
        self._end_tr_element();
        return ["reprocess", self.mode, token];
      }

      const previous = self.insert_from_table;
      self.insert_from_table = true;
      try {
        return modeInBody(self, token);
      } finally {
        self.insert_from_table = previous;
      }
    }

    if (name === "tr") {
      if (!self._has_in_table_scope("tr")) {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      self._end_tr_element();
      return null;
    }

    if (name === "table" || name === "tbody" || name === "tfoot" || name === "thead") {
      if (self._has_in_table_scope(name)) {
        self._end_tr_element();
        return ["reprocess", self.mode, token];
      }
      self._parse_error("unexpected-end-tag", name);
      return null;
    }

    if (ROW_UNEXPECTED_END_TAGS.has(name)) {
      self._parse_error("unexpected-end-tag", name);
      return null;
    }

    const previous = self.insert_from_table;
    self.insert_from_table = true;
    try {
      return modeInBody(self, token);
    } finally {
      self.insert_from_table = previous;
    }
  }

  if (token instanceof EOFToken) return modeInTable(self, token);
  return null;
}

const CELL_STRUCTURE_TAGS = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);

function modeInCell(self, token) {
  if (token instanceof CharacterToken) {
    const previous = self.insert_from_table;
    self.insert_from_table = false;
    try {
      return modeInBody(self, token);
    } finally {
      self.insert_from_table = previous;
    }
  }
  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (CELL_STRUCTURE_TAGS.has(name)) {
        if (self._close_table_cell()) return ["reprocess", self.mode, token];
        self._parse_error("unexpected-start-tag-in-cell-fragment", name);
        return null;
      }
      const previous = self.insert_from_table;
      self.insert_from_table = false;
      try {
        return modeInBody(self, token);
      } finally {
        self.insert_from_table = previous;
      }
    }

    if (name === "td" || name === "th") {
      if (!self._has_in_table_scope(name)) {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      self._end_table_cell(name);
      return null;
    }

    if (name === "table" || name === "tbody" || name === "tfoot" || name === "thead" || name === "tr") {
      if (!self._has_in_table_scope(name)) {
        self._parse_error("unexpected-end-tag", name);
        return null;
      }
      self._close_table_cell();
      return ["reprocess", self.mode, token];
    }

    const previous = self.insert_from_table;
    self.insert_from_table = false;
    try {
      return modeInBody(self, token);
    } finally {
      self.insert_from_table = previous;
    }
  }

  if (token instanceof EOFToken) {
    if (self._close_table_cell()) return ["reprocess", self.mode, token];
    return modeInTable(self, token);
  }
  return null;
}

function modeInFrameset(self, token) {
  if (token instanceof CharacterToken) {
    const data = token.data || "";
    let whitespace = "";
    for (const ch of data) {
      if (ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ") whitespace += ch;
    }
    if (whitespace) self._append_text(whitespace);
    return null;
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") return ["reprocess", InsertionMode.IN_BODY, token];
    if (token.kind === Tag.START && token.name === "frameset") {
      self._insert_element(token, { push: true });
      return null;
    }
    if (token.kind === Tag.END && token.name === "frameset") {
      if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "html") {
        self._parse_error("unexpected-end-tag", token.name);
        return null;
      }
      self.openElements.pop();
      if (self.openElements.length && self.openElements[self.openElements.length - 1].name !== "frameset") {
        self.mode = InsertionMode.AFTER_FRAMESET;
      }
      return null;
    }
    if (token.kind === Tag.START && token.name === "frame") {
      self._insert_element(token, { push: true });
      self.openElements.pop();
      return null;
    }
    if (token.kind === Tag.START && token.name === "noframes") {
      self._insert_element(token, { push: true });
      self.original_mode = self.mode;
      self.mode = InsertionMode.TEXT;
      return null;
    }
  }

  if (token instanceof EOFToken) {
    if (self.openElements.length && self.openElements[self.openElements.length - 1].name !== "html") {
      self._parse_error("expected-closing-tag-but-got-eof", self.openElements[self.openElements.length - 1].name);
    }
    return null;
  }

  self._parse_error("unexpected-token-in-frameset");
  return null;
}

function modeAfterFrameset(self, token) {
  if (token instanceof CharacterToken) {
    const data = token.data || "";
    let whitespace = "";
    for (const ch of data) {
      if (ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ") whitespace += ch;
    }
    if (whitespace) self._append_text(whitespace);
    return null;
  }
  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }
  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") return ["reprocess", InsertionMode.IN_BODY, token];
    if (token.kind === Tag.END && token.name === "html") {
      self.mode = InsertionMode.AFTER_AFTER_FRAMESET;
      return null;
    }
    if (token.kind === Tag.START && token.name === "noframes") {
      self._insert_element(token, { push: true });
      self.original_mode = self.mode;
      self.mode = InsertionMode.TEXT;
      return null;
    }
  }
  if (token instanceof EOFToken) return null;

  self._parse_error("unexpected-token-after-frameset");
  self.mode = InsertionMode.IN_FRAMESET;
  return ["reprocess", InsertionMode.IN_FRAMESET, token];
}

function modeAfterAfterFrameset(self, token) {
  if (token instanceof CharacterToken) {
    if (isAllWhitespace(token.data)) {
      modeInBody(self, token);
      return null;
    }
  }
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }
  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") return ["reprocess", InsertionMode.IN_BODY, token];
    if (token.kind === Tag.START && token.name === "noframes") {
      self._insert_element(token, { push: true });
      self.original_mode = self.mode;
      self.mode = InsertionMode.TEXT;
      return null;
    }
  }
  if (token instanceof EOFToken) return null;

  self._parse_error("unexpected-token-after-after-frameset");
  self.mode = InsertionMode.IN_FRAMESET;
  return ["reprocess", InsertionMode.IN_FRAMESET, token];
}

const SELECT_END_TAG_TABLE_ELEMENTS = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr", "table"]);
const SELECT_ALLOWED_ELEMENTS = new Set(["p", "div", "span", "button", "datalist", "selectedcontent"]);
const SELECT_HEAD_TAGS = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "script",
  "style",
  "template",
  "title",
]);

function modeInSelect(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint-in-select");
      data = data.replaceAll("\x00", "");
    }
    if (data.includes("\x0c")) {
      self._parse_error("invalid-codepoint-in-select");
      data = data.replaceAll("\x0c", "");
    }
    if (data) {
      self._reconstruct_active_formatting_elements();
      self._append_text(data);
    }
    return null;
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    const name = token.name;
    if (token.kind === Tag.START) {
      if (name === "html") return ["reprocess", InsertionMode.IN_BODY, token];
      if (name === "option") {
        if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
          self.openElements.pop();
        }
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: true });
        return null;
      }
      if (name === "optgroup") {
        if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
          self.openElements.pop();
        }
        if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "optgroup") {
          self.openElements.pop();
        }
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: true });
        return null;
      }
      if (name === "select") {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        self._pop_until_any_inclusive(new Set(["select"]));
        self._reset_insertion_mode();
        return null;
      }
      if (name === "input" || name === "textarea") {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        self._pop_until_any_inclusive(new Set(["select"]));
        self._reset_insertion_mode();
        return ["reprocess", self.mode, token];
      }
      if (name === "keygen") {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: false });
        return null;
      }
      if (SELECT_END_TAG_TABLE_ELEMENTS.has(name)) {
        self._parse_error("unexpected-start-tag-implies-end-tag", name);
        self._pop_until_any_inclusive(new Set(["select"]));
        self._reset_insertion_mode();
        return ["reprocess", self.mode, token];
      }
      if (name === "script" || name === "template") return modeInHead(self, token);
      if (name === "svg" || name === "math") {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: !token.selfClosing, namespace: name });
        return null;
      }
      if (FORMATTING_ELEMENTS.has(name)) {
        self._reconstruct_active_formatting_elements();
        const node = self._insert_element(token, { push: true });
        self._append_active_formatting_entry(name, token.attrs, node);
        return null;
      }
      if (name === "hr") {
        if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
          self.openElements.pop();
        }
        if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "optgroup") {
          self.openElements.pop();
        }
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: false });
        return null;
      }
      if (name === "menuitem") {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: true });
        return null;
      }
      if (SELECT_ALLOWED_ELEMENTS.has(name)) {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: !token.selfClosing });
        return null;
      }
      if (name === "br" || name === "img") {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: false });
        return null;
      }
      if (name === "plaintext") {
        self._reconstruct_active_formatting_elements();
        self._insert_element(token, { push: true });
        return null;
      }
      return null;
    }

    // End tag.
    if (name === "optgroup") {
      if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
        self.openElements.pop();
      }
      if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "optgroup") {
        self.openElements.pop();
      } else {
        self._parse_error("unexpected-end-tag", name);
      }
      return null;
    }
    if (name === "option") {
      if (self.openElements.length && self.openElements[self.openElements.length - 1].name === "option") {
        self.openElements.pop();
      } else {
        self._parse_error("unexpected-end-tag", name);
      }
      return null;
    }
    if (name === "select") {
      self._pop_until_any_inclusive(new Set(["select"]));
      self._reset_insertion_mode();
      return null;
    }

    if (name === "a" || FORMATTING_ELEMENTS.has(name)) {
      const selectNode = self._find_last_on_stack("select");
      const fmtIndex = self._find_active_formatting_index(name);
      if (fmtIndex != null) {
        const target = self.active_formatting[fmtIndex].node;
        if (target && self.openElements.includes(target) && selectNode) {
          const selectIndex = self.openElements.indexOf(selectNode);
          const targetIndex = self.openElements.indexOf(target);
          if (targetIndex < selectIndex) {
            self._parse_error("unexpected-end-tag", name);
            return null;
          }
        }
      }
      self._adoption_agency(name);
      return null;
    }

    if (SELECT_ALLOWED_ELEMENTS.has(name)) {
      let selectIdx = null;
      let targetIdx = null;
      for (let i = 0; i < self.openElements.length; i += 1) {
        const node = self.openElements[i];
        if (node.name === "select" && selectIdx == null) selectIdx = i;
        if (node.name === name) targetIdx = i;
      }
      if (targetIdx != null && (selectIdx == null || targetIdx > selectIdx)) {
        while (self.openElements.length) {
          const popped = self.openElements.pop();
          if (popped.name === name) break;
        }
      } else {
        self._parse_error("unexpected-end-tag", name);
      }
      return null;
    }

    if (SELECT_END_TAG_TABLE_ELEMENTS.has(name)) {
      self._parse_error("unexpected-end-tag", name);
      self._pop_until_any_inclusive(new Set(["select"]));
      self._reset_insertion_mode();
      return ["reprocess", self.mode, token];
    }

    self._parse_error("unexpected-end-tag", name);
    return null;
  }

  if (token instanceof EOFToken) return modeInBody(self, token);
  return null;
}

function modeInTemplate(self, token) {
  if (token instanceof CharacterToken) return modeInBody(self, token);
  if (token instanceof CommentToken) return modeInBody(self, token);

  if (token instanceof Tag) {
    if (token.kind === Tag.START) {
      if (token.name === "caption" || token.name === "colgroup" || token.name === "tbody" || token.name === "tfoot" || token.name === "thead") {
        self.template_modes.pop();
        self.template_modes.push(InsertionMode.IN_TABLE);
        self.mode = InsertionMode.IN_TABLE;
        return ["reprocess", InsertionMode.IN_TABLE, token];
      }
      if (token.name === "col") {
        self.template_modes.pop();
        self.template_modes.push(InsertionMode.IN_COLUMN_GROUP);
        self.mode = InsertionMode.IN_COLUMN_GROUP;
        return ["reprocess", InsertionMode.IN_COLUMN_GROUP, token];
      }
      if (token.name === "tr") {
        self.template_modes.pop();
        self.template_modes.push(InsertionMode.IN_TABLE_BODY);
        self.mode = InsertionMode.IN_TABLE_BODY;
        return ["reprocess", InsertionMode.IN_TABLE_BODY, token];
      }
      if (token.name === "td" || token.name === "th") {
        self.template_modes.pop();
        self.template_modes.push(InsertionMode.IN_ROW);
        self.mode = InsertionMode.IN_ROW;
        return ["reprocess", InsertionMode.IN_ROW, token];
      }

      if (!SELECT_HEAD_TAGS.has(token.name)) {
        self.template_modes.pop();
        self.template_modes.push(InsertionMode.IN_BODY);
        self.mode = InsertionMode.IN_BODY;
        return ["reprocess", InsertionMode.IN_BODY, token];
      }
    }

    if (token.kind === Tag.END && token.name === "template") return modeInHead(self, token);

    if (SELECT_HEAD_TAGS.has(token.name)) return modeInHead(self, token);
  }

  if (token instanceof EOFToken) {
    const hasTemplate = self.openElements.some((node) => node.name === "template");
    if (!hasTemplate) return null;
    self._parse_error("expected-closing-tag-but-got-eof", "template");
    self._pop_until_inclusive("template");
    self._clear_active_formatting_up_to_marker();
    self.template_modes.pop();
    self._reset_insertion_mode();
    return ["reprocess", self.mode, token];
  }

  return null;
}

// Placeholder for any unported modes.
function modeFallbackToBody(self, token) {
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
}

const MODE_HANDLERS = [
  modeInitial,
  modeBeforeHtml,
  modeBeforeHead,
  modeInHead,
  modeInHeadNoscript,
  modeAfterHead,
  modeText,
  modeInBody,
  modeAfterBody,
  modeAfterAfterBody,
  modeInTable,
  modeInTableText,
  modeInCaption,
  modeInColumnGroup,
  modeInTableBody,
  modeInRow,
  modeInCell,
  modeInFrameset,
  modeAfterFrameset,
  modeAfterAfterFrameset,
  modeInSelect,
  modeInTemplate,
];

export class TreeBuilder {
  constructor(fragment_context = null, iframe_srcdoc = false, collect_errors = false) {
    this.fragment_context = fragment_context;
    this.iframe_srcdoc = Boolean(iframe_srcdoc);
    this.collect_errors = Boolean(collect_errors);

    this.errors = [];
    this.tokenizer = null;
    this.fragment_context_element = null;

    if (fragment_context != null) this.document = new Node("#document-fragment", { namespace: null });
    else this.document = new Node("#document", { namespace: null });

    this.mode = InsertionMode.INITIAL;
    this.original_mode = null;
    this.table_text_original_mode = null;
    this.openElements = [];
    this.head_element = null;
    this.form_element = null;
    this.frameset_ok = true;
    this.quirks_mode = "no-quirks";
    this.ignore_lf = false;
    this.active_formatting = [];
    this.insert_from_table = false;
    this.pending_table_text = [];
    this.template_modes = [];
    this.tokenizer_state_override = null;

    if (fragment_context != null) {
      // Fragment parsing per HTML5 spec
      const root = this._create_element("html", null, {});
      this.document.append_child(root);
      this.openElements.push(root);

      const namespace = fragment_context.namespace;
      const contextName = fragment_context.tag_name || fragment_context.tagName || "";
      const name = contextName.toLowerCase();

      if (namespace && namespace !== "html") {
        let adjustedName = contextName;
        if (namespace === "svg") adjustedName = this._adjust_svg_tag_name(contextName);
        const contextElement = this._create_element(adjustedName, namespace, {});
        root.append_child(contextElement);
        this.openElements.push(contextElement);
        this.fragment_context_element = contextElement;
      }

      if (name === "html") this.mode = InsertionMode.BEFORE_HEAD;
      else if ((namespace == null || namespace === "html") && ["tbody", "thead", "tfoot"].includes(name))
        this.mode = InsertionMode.IN_TABLE_BODY;
      else if ((namespace == null || namespace === "html") && name === "tr") this.mode = InsertionMode.IN_ROW;
      else if ((namespace == null || namespace === "html") && ["td", "th"].includes(name)) this.mode = InsertionMode.IN_CELL;
      else if ((namespace == null || namespace === "html") && name === "caption") this.mode = InsertionMode.IN_CAPTION;
      else if ((namespace == null || namespace === "html") && name === "colgroup") this.mode = InsertionMode.IN_COLUMN_GROUP;
      else if ((namespace == null || namespace === "html") && name === "table") this.mode = InsertionMode.IN_TABLE;
      else this.mode = InsertionMode.IN_BODY;

      this.frameset_ok = false;
    }
  }

  _set_quirks_mode(mode) {
    this.quirks_mode = mode;
  }

  _parse_error(code, tag_name = null) {
    if (!this.collect_errors) return;
    this.errors.push(new ParseError(code, { message: tag_name ? `${code}: ${tag_name}` : code }));
  }

  _has_element_in_scope(target, terminators = null, checkIntegrationPoints = true) {
    const terms = terminators || DEFAULT_SCOPE_TERMINATORS;
    for (let idx = this.openElements.length - 1; idx >= 0; idx -= 1) {
      const node = this.openElements[idx];
      if (node.name === target) return true;

      const ns = node.namespace;
      if (ns === "html" || ns == null) {
        if (terms.has(node.name)) return false;
      } else if (checkIntegrationPoints && (this._is_html_integration_point(node) || this._is_mathml_text_integration_point(node))) {
        return false;
      }
    }
    return false;
  }

  _has_element_in_button_scope(target) {
    return this._has_element_in_scope(target, BUTTON_SCOPE_TERMINATORS);
  }

  _pop_until_inclusive(name) {
    while (this.openElements.length) {
      const node = this.openElements.pop();
      if (node.name === name) break;
    }
  }

  _pop_until_any_inclusive(names) {
    while (this.openElements.length) {
      const node = this.openElements.pop();
      if (names.has(node.name)) return;
    }
  }

  _close_p_element() {
    if (this._has_element_in_button_scope("p")) {
      this._generate_implied_end_tags("p");
      if (this.openElements.length && this.openElements[this.openElements.length - 1].name !== "p") {
        this._parse_error("end-tag-too-early", "p");
      }
      this._pop_until_inclusive("p");
      return true;
    }
    return false;
  }

  _in_scope(name) {
    return this._has_element_in_scope(name, DEFAULT_SCOPE_TERMINATORS);
  }

  _close_element_by_name(name) {
    let index = this.openElements.length - 1;
    while (index >= 0) {
      if (this.openElements[index].name === name) {
        this.openElements.splice(index);
        return;
      }
      index -= 1;
    }
  }

  _any_other_end_tag(name) {
    let index = this.openElements.length - 1;
    while (index >= 0) {
      const node = this.openElements[index];
      if (node.name === name) {
        if (index !== this.openElements.length - 1) this._parse_error("end-tag-too-early");
        this.openElements.splice(index);
        return;
      }
      if (this._is_special_element(node)) {
        this._parse_error("unexpected-end-tag", name);
        return;
      }
      index -= 1;
    }
  }

  _generate_implied_end_tags(exclude = null) {
    while (this.openElements.length) {
      const node = this.openElements[this.openElements.length - 1];
      if (IMPLIED_END_TAGS.has(node.name) && node.name !== exclude) {
        this.openElements.pop();
        continue;
      }
      break;
    }
  }

  _clear_active_formatting_up_to_marker() {
    while (this.active_formatting.length) {
      const entry = this.active_formatting.pop();
      if (entry === FORMAT_MARKER) break;
    }
  }

  _push_formatting_marker() {
    this.active_formatting.push(FORMAT_MARKER);
  }

  _reset_insertion_mode() {
    for (let idx = this.openElements.length - 1; idx >= 0; idx -= 1) {
      const node = this.openElements[idx];
      const tagId = node.tagId ?? getTagId(node.name);
      switch (tagId) {
        case TagId.SELECT:
          this.mode = InsertionMode.IN_SELECT;
          return;
        case TagId.TD:
        case TagId.TH:
          this.mode = InsertionMode.IN_CELL;
          return;
        case TagId.TR:
          this.mode = InsertionMode.IN_ROW;
          return;
        case TagId.TBODY:
        case TagId.TFOOT:
        case TagId.THEAD:
          this.mode = InsertionMode.IN_TABLE_BODY;
          return;
        case TagId.CAPTION:
          this.mode = InsertionMode.IN_CAPTION;
          return;
        case TagId.TABLE:
          this.mode = InsertionMode.IN_TABLE;
          return;
        case TagId.TEMPLATE:
          if (this.template_modes.length) {
            this.mode = this.template_modes[this.template_modes.length - 1];
            return;
          }
          break;
        case TagId.HEAD:
          this.mode = InsertionMode.IN_HEAD;
          return;
        case TagId.HTML:
          this.mode = InsertionMode.IN_BODY;
          return;
      }
    }
    this.mode = InsertionMode.IN_BODY;
  }

  process_token(token) {
    return this.processToken(token);
  }

  processToken(token) {
    if (token instanceof DoctypeToken) {
      if (this.openElements.length) {
        const current = this.openElements[this.openElements.length - 1];
        if (current.namespace != null && current.namespace !== "html") {
          this._parse_error("unexpected-doctype");
          return TokenSinkResult.Continue;
        }
      }
      return handleDoctype(this, token);
    }

    let currentToken = token;
    let forceHtmlMode = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentNode = this.openElements.length ? this.openElements[this.openElements.length - 1] : null;
      const isHtmlNamespace = currentNode == null || currentNode.namespace == null || currentNode.namespace === "html";

      let result = null;

      if (forceHtmlMode || isHtmlNamespace) {
        forceHtmlMode = false;
        const handler = MODE_HANDLERS[this.mode] || modeFallbackToBody;
        result = handler(this, currentToken);
      } else if (this._should_use_foreign_content(currentToken)) {
        result = this._process_foreign_content(currentToken);
      } else {
        if (currentToken instanceof CharacterToken && this._is_mathml_text_integration_point(currentNode)) {
          let data = currentToken.data || "";
          if (data.includes("\x00")) {
            this._parse_error("invalid-codepoint");
            data = data.replaceAll("\x00", "");
          }
          if (data.includes("\x0c")) {
            this._parse_error("invalid-codepoint");
            data = data.replaceAll("\x0c", "");
          }
          if (data) {
            if (!isAllWhitespace(data)) {
              this._reconstruct_active_formatting_elements();
              this.frameset_ok = false;
            }
            this._append_text(data);
          }
          result = null;
        } else {
          const isIntegrationPoint =
            this._is_mathml_text_integration_point(currentNode) || this._is_html_integration_point(currentNode);

          if (
            isIntegrationPoint &&
            currentToken instanceof Tag &&
            currentToken.kind === Tag.START &&
            this.mode !== InsertionMode.IN_BODY
          ) {
            const isTableMode =
              this.mode === InsertionMode.IN_TABLE ||
              this.mode === InsertionMode.IN_TABLE_BODY ||
              this.mode === InsertionMode.IN_ROW ||
              this.mode === InsertionMode.IN_CELL ||
              this.mode === InsertionMode.IN_CAPTION ||
              this.mode === InsertionMode.IN_COLUMN_GROUP;
            const hasTableInScope = this._has_in_table_scope("table");

            if (isTableMode && !hasTableInScope) {
              const savedMode = this.mode;
              this.mode = InsertionMode.IN_BODY;
              const handler = MODE_HANDLERS[this.mode] || modeFallbackToBody;
              result = handler(this, currentToken);
              if (this.mode === InsertionMode.IN_BODY) this.mode = savedMode;
            } else {
              const handler = MODE_HANDLERS[this.mode] || modeFallbackToBody;
              result = handler(this, currentToken);
            }
          } else {
            const handler = MODE_HANDLERS[this.mode] || modeFallbackToBody;
            result = handler(this, currentToken);
          }
        }
      }

      if (result == null) {
        const out = this.tokenizer_state_override ?? TokenSinkResult.Continue;
        this.tokenizer_state_override = null;
        return out;
      }

      // Handle both Reprocess class and legacy array format
      if (result instanceof Reprocess) {
        this.mode = result.mode;
        currentToken = result.token;
        forceHtmlMode = result.forceHtml;
      } else {
        const [, mode, tokenOverride, forceHtml] = result;
        this.mode = mode;
        currentToken = tokenOverride;
        forceHtmlMode = Boolean(forceHtml);
      }
    }
  }

  process_characters(data) {
    return this.processCharacters(data);
  }

  processCharacters(data) {
    const currentNode = this.openElements.length ? this.openElements[this.openElements.length - 1] : null;
    const isHtmlNamespace = currentNode == null || currentNode.namespace == null || currentNode.namespace === "html";
    if (!isHtmlNamespace) return this.processToken(new CharacterToken(data));
    return this.processToken(new CharacterToken(data));
  }

  finish() {
    if (this.fragment_context != null) {
      const root = this.document.children[0];
      const contextElem = this.fragment_context_element;
      if (contextElem && contextElem.parent === root) {
        for (const child of [...contextElem.children]) {
          contextElem.remove_child(child);
          root.append_child(child);
        }
        root.remove_child(contextElem);
      }
      for (const child of [...root.children]) {
        root.remove_child(child);
        this.document.append_child(child);
      }
      this.document.remove_child(root);
    }

    this._populate_selectedcontent(this.document);
    return this.document;
  }

  // ---------------- Insertion helpers ----------------

  _append_comment_to_document(text) {
    this.document.append_child(new Node("#comment", { data: text, namespace: null }));
  }

  _append_comment(text, parent = null) {
    let target = parent;
    if (!target) target = this._current_node_or_html();
    if (isTemplateNode(target)) target = target.templateContent;
    target.append_child(new Node("#comment", { data: text, namespace: null }));
  }

  _append_text(text) {
    if (!text) return;
    if (this.ignore_lf) {
      this.ignore_lf = false;
      if (text.startsWith("\n")) {
        text = text.slice(1);
        if (!text) return;
      }
    }

    if (!this.openElements.length) return;

    const target = this.openElements[this.openElements.length - 1];
    if (!TABLE_FOSTER_TARGETS.has(target.name) && !isTemplateNode(target)) {
      const children = target.children;
      if (children.length && children[children.length - 1].name === "#text") {
        children[children.length - 1].data = (children[children.length - 1].data || "") + text;
        return;
      }
      target.append_child(new Node("#text", { data: text, namespace: null }));
      return;
    }

    const adjustedTarget = this._current_node_or_html();
    const foster = this._should_foster_parenting(adjustedTarget, { isText: true });
    if (foster) this._reconstruct_active_formatting_elements();

    const [parent, position] = this._appropriate_insertion_location(null, { foster_parenting: foster });
    if (position > 0 && parent.children[position - 1]?.name === "#text") {
      parent.children[position - 1].data = (parent.children[position - 1].data || "") + text;
      return;
    }

    this._insert_node_at(parent, position, new Node("#text", { data: text, namespace: null }));
  }

  _current_node_or_html() {
    if (this.openElements.length) return this.openElements[this.openElements.length - 1];
    for (const child of this.document.children) {
      if (child.name === "html") return child;
    }
    return this.document.children.length ? this.document.children[0] : null;
  }

  _create_root(attrs) {
    const node = new Node("html", { attrs: attrs || {}, namespace: "html" });
    this.document.append_child(node);
    this.openElements.push(node);
    return node;
  }

  _insert_element(tag, { push, namespace = "html" } = {}) {
    const node = new Node(tag.name, { attrs: tag.attrs || {}, namespace });

    if (!this.insert_from_table) {
      const target = this._current_node_or_html();
      const parent = isTemplateNode(target) ? target.templateContent : target;
      parent.append_child(node);
      if (push) this.openElements.push(node);
      return node;
    }

    const target = this._current_node_or_html();
    const foster = this._should_foster_parenting(target, { forTag: tag.name });
    const [parent, position] = this._appropriate_insertion_location(null, { foster_parenting: foster });
    this._insert_node_at(parent, position, node);
    if (push) this.openElements.push(node);
    return node;
  }

  _insert_phantom(name) {
    const tag = new Tag(Tag.START, name, {}, false);
    return this._insert_element(tag, { push: true });
  }

  _insert_body_if_missing() {
    const htmlNode = this._find_last_on_stack("html");
    const node = new Node("body", { namespace: "html" });
    htmlNode.append_child(node);
    this.openElements.push(node);
  }

  _create_element(name, namespace, attrs) {
    const ns = namespace || "html";
    return new Node(name, { attrs: attrs || {}, namespace: ns });
  }

  _pop_current() {
    return this.openElements.pop();
  }

  _add_missing_attributes(node, attrs) {
    if (!attrs) return;
    const existing = node.attrs || {};
    for (const [name, value] of Object.entries(attrs)) {
      if (!Object.prototype.hasOwnProperty.call(existing, name)) existing[name] = value;
    }
    node.attrs = existing;
  }

  _remove_from_openElements(node) {
    for (let index = 0; index < this.openElements.length; index += 1) {
      if (this.openElements[index] === node) {
        this.openElements.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  _is_special_element(node) {
    if (node.namespace != null && node.namespace !== "html") return false;
    return SPECIAL_ELEMENTS.has(node.name);
  }

  _find_active_formatting_index(name) {
    for (let index = this.active_formatting.length - 1; index >= 0; index -= 1) {
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER) break;
      if (entry.name === name) return index;
    }
    return null;
  }

  _find_active_formatting_index_by_node(node) {
    for (let index = this.active_formatting.length - 1; index >= 0; index -= 1) {
      const entry = this.active_formatting[index];
      if (entry !== FORMAT_MARKER && entry.node === node) return index;
    }
    return null;
  }

  _clone_attributes(attrs) {
    return attrs ? { ...attrs } : {};
  }

  _attrs_signature(attrs) {
    if (!attrs) return "";
    const keys = Object.keys(attrs);
    if (!keys.length) return "";
    keys.sort();
    let out = "";
    for (const key of keys) {
      const value = attrs[key] || "";
      out += `${key}\u0000${value}\u0001`;
    }
    return out;
  }

  _find_active_formatting_duplicate(name, attrs) {
    const signature = this._attrs_signature(attrs);
    const matches = [];
    for (let index = 0; index < this.active_formatting.length; index += 1) {
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER) {
        matches.length = 0;
        continue;
      }
      if (entry.name === name && entry.signature === signature) matches.push(index);
    }
    if (matches.length >= 3) return matches[0];
    return null;
  }

  _has_active_formatting_entry(name) {
    for (let index = this.active_formatting.length - 1; index >= 0; index -= 1) {
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER) break;
      if (entry.name === name) return true;
    }
    return false;
  }

  _remove_last_active_formatting_by_name(name) {
    for (let index = this.active_formatting.length - 1; index >= 0; index -= 1) {
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER) break;
      if (entry.name === name) {
        this.active_formatting.splice(index, 1);
        return;
      }
    }
  }

  _remove_last_open_element_by_name(name) {
    for (let index = this.openElements.length - 1; index >= 0; index -= 1) {
      if (this.openElements[index].name === name) {
        this.openElements.splice(index, 1);
        return;
      }
    }
  }

  _append_active_formatting_entry(name, attrs, node) {
    const entryAttrs = this._clone_attributes(attrs);
    this.active_formatting.push({
      name,
      attrs: entryAttrs,
      node,
      signature: this._attrs_signature(entryAttrs),
    });
  }

  _remove_formatting_entry(index) {
    if (index < 0 || index >= this.active_formatting.length) throw new Error(`Invalid formatting index: ${index}`);
    this.active_formatting.splice(index, 1);
  }

  _reconstruct_active_formatting_elements() {
    if (!this.active_formatting.length) return;
    const lastEntry = this.active_formatting[this.active_formatting.length - 1];
    if (lastEntry === FORMAT_MARKER) return;
    if (this.openElements.includes(lastEntry.node)) return;

    let index = this.active_formatting.length - 1;
    while (true) {
      index -= 1;
      if (index < 0) break;
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER || this.openElements.includes(entry.node)) {
        index += 1;
        break;
      }
    }
    if (index < 0) index = 0;

    while (index < this.active_formatting.length) {
      const entry = this.active_formatting[index];
      if (entry === FORMAT_MARKER) {
        index += 1;
        continue;
      }
      const tag = new Tag(Tag.START, entry.name, this._clone_attributes(entry.attrs), false);
      const newNode = this._insert_element(tag, { push: true });
      entry.node = newNode;
      index += 1;
    }
  }

  _adoption_agency(subject) {
    if (this.openElements.length && this.openElements[this.openElements.length - 1].name === subject) {
      if (!this._has_active_formatting_entry(subject)) {
        this._pop_until_inclusive(subject);
        return;
      }
    }

    for (let outer = 0; outer < 8; outer += 1) {
      const formattingElementIndex = this._find_active_formatting_index(subject);
      if (formattingElementIndex == null) return;

      const formattingEntry = this.active_formatting[formattingElementIndex];
      if (formattingEntry === FORMAT_MARKER) return;
      const formattingElement = formattingEntry.node;

      if (!this.openElements.includes(formattingElement)) {
        this._parse_error("adoption-agency-1.3");
        this._remove_formatting_entry(formattingElementIndex);
        return;
      }

      if (!this._has_element_in_scope(formattingElement.name)) {
        this._parse_error("adoption-agency-1.3");
        return;
      }

      if (formattingElement !== this.openElements[this.openElements.length - 1]) {
        this._parse_error("adoption-agency-1.3");
      }

      let furthestBlock = null;
      const formattingElementInOpenIndex = this.openElements.indexOf(formattingElement);
      for (let i = formattingElementInOpenIndex + 1; i < this.openElements.length; i += 1) {
        const node = this.openElements[i];
        if (this._is_special_element(node)) {
          furthestBlock = node;
          break;
        }
      }

      if (!furthestBlock) {
        while (this.openElements.length) {
          const popped = this.openElements.pop();
          if (popped === formattingElement) break;
        }
        this._remove_formatting_entry(formattingElementIndex);
        return;
      }

      let bookmark = formattingElementIndex + 1;
      let node = furthestBlock;
      let lastNode = furthestBlock;

      let innerLoopCounter = 0;
      while (true) {
        innerLoopCounter += 1;

        const nodeIndex = this.openElements.indexOf(node);
        node = this.openElements[nodeIndex - 1];

        if (node === formattingElement) break;

        let nodeFormattingIndex = this._find_active_formatting_index_by_node(node);

        if (innerLoopCounter > 3 && nodeFormattingIndex != null) {
          this._remove_formatting_entry(nodeFormattingIndex);
          if (nodeFormattingIndex < bookmark) bookmark -= 1;
          nodeFormattingIndex = null;
        }

        if (nodeFormattingIndex == null) {
          const idx = this.openElements.indexOf(node);
          this.openElements.splice(idx, 1);
          node = this.openElements[idx];
          continue;
        }

        const entry = this.active_formatting[nodeFormattingIndex];
        const newElement = this._create_element(entry.name, entry.node.namespace, entry.attrs);
        entry.node = newElement;
        this.openElements[this.openElements.indexOf(node)] = newElement;
        node = newElement;

        if (lastNode === furthestBlock) bookmark = nodeFormattingIndex + 1;

        if (lastNode.parent) lastNode.parent.remove_child(lastNode);
        node.append_child(lastNode);

        lastNode = node;
      }

      const commonAncestor = this.openElements[formattingElementInOpenIndex - 1];
      if (lastNode.parent) lastNode.parent.remove_child(lastNode);

      if (this._should_foster_parenting(commonAncestor, { forTag: lastNode.name })) {
        const [parent, position] = this._appropriate_insertion_location(commonAncestor, { foster_parenting: true });
        this._insert_node_at(parent, position, lastNode);
      } else if (isTemplateNode(commonAncestor) && commonAncestor.templateContent) {
        commonAncestor.templateContent.append_child(lastNode);
      } else {
        commonAncestor.append_child(lastNode);
      }

      const entry = this.active_formatting[formattingElementIndex];
      const newFormattingElement = this._create_element(entry.name, entry.node.namespace, entry.attrs);
      entry.node = newFormattingElement;

      while (furthestBlock.has_child_nodes && furthestBlock.has_child_nodes()) {
        const child = furthestBlock.children[0];
        furthestBlock.remove_child(child);
        newFormattingElement.append_child(child);
      }
      furthestBlock.append_child(newFormattingElement);

      this._remove_formatting_entry(formattingElementIndex);
      bookmark -= 1;
      this.active_formatting.splice(bookmark, 0, entry);

      const fmtOpenIndex = this.openElements.indexOf(formattingElement);
      if (fmtOpenIndex !== -1) this.openElements.splice(fmtOpenIndex, 1);
      const furthestBlockIndex = this.openElements.indexOf(furthestBlock);
      this.openElements.splice(furthestBlockIndex + 1, 0, newFormattingElement);
    }
  }

  _find_last_on_stack(name) {
    for (let idx = this.openElements.length - 1; idx >= 0; idx -= 1) {
      const node = this.openElements[idx];
      if (node.name === name) return node;
    }
    return null;
  }

  _insert_node_at(parent, index, node) {
    const ref = index != null && index < parent.children.length ? parent.children[index] : null;
    parent.insert_before(node, ref);
  }

  _appropriate_insertion_location(override_target = null, { foster_parenting = false } = {}) {
    const target = override_target || this._current_node_or_html();
    if (foster_parenting && TABLE_FOSTER_TARGETS.has(target.name)) {
      const lastTemplate = this._find_last_on_stack("template");
      const lastTable = this._find_last_on_stack("table");
      if (
        lastTemplate &&
        (lastTable == null || this.openElements.indexOf(lastTemplate) > this.openElements.indexOf(lastTable))
      ) {
        return [lastTemplate.templateContent, lastTemplate.templateContent.children.length];
      }
      if (!lastTable) return [target, target.children.length];
      const parent = lastTable.parent;
      if (!parent) return [target, target.children.length];
      const pos = parent.children.indexOf(lastTable);
      return [parent, pos];
    }
    if (isTemplateNode(target)) return [target.templateContent, target.templateContent.children.length];
    return [target, target.children.length];
  }

  _has_in_table_scope(name) {
    return this._has_element_in_scope(name, TABLE_SCOPE_TERMINATORS, false);
  }

  _clear_stack_until(names) {
    while (this.openElements.length) {
      const node = this.openElements[this.openElements.length - 1];
      if ((node.namespace == null || node.namespace === "html") && names.has(node.name)) break;
      this.openElements.pop();
    }
  }

  _close_table_cell() {
    if (this._has_in_table_scope("td")) {
      this._end_table_cell("td");
      return true;
    }
    if (this._has_in_table_scope("th")) {
      this._end_table_cell("th");
      return true;
    }
    return false;
  }

  _end_table_cell(name) {
    this._generate_implied_end_tags(name);
    while (this.openElements.length) {
      const node = this.openElements.pop();
      if (node.name === name && (node.namespace == null || node.namespace === "html")) break;
    }
    this._clear_active_formatting_up_to_marker();
    this.mode = InsertionMode.IN_ROW;
  }

  _close_caption_element() {
    if (!this._has_in_table_scope("caption")) {
      this._parse_error("unexpected-end-tag", "caption");
      return false;
    }
    this._generate_implied_end_tags();
    while (this.openElements.length) {
      const node = this.openElements.pop();
      if (node.name === "caption") break;
    }
    this._clear_active_formatting_up_to_marker();
    this.mode = InsertionMode.IN_TABLE;
    return true;
  }

  _end_tr_element() {
    this._clear_stack_until(TABLE_ROW_CONTEXT_CLEAR_UNTIL);
    if (this.openElements.length && this.openElements[this.openElements.length - 1].name === "tr") {
      this.openElements.pop();
    }
    if (this.template_modes.length) this.mode = this.template_modes[this.template_modes.length - 1];
    else this.mode = InsertionMode.IN_TABLE_BODY;
  }

  _flush_pending_table_text() {
    const data = this.pending_table_text.join("");
    this.pending_table_text.length = 0;
    if (!data) return;
    if (isAllWhitespace(data)) {
      this._append_text(data);
      return;
    }
    this._parse_error("foster-parenting-character");
    const previous = this.insert_from_table;
    this.insert_from_table = true;
    try {
      this._reconstruct_active_formatting_elements();
      this._append_text(data);
    } finally {
      this.insert_from_table = previous;
    }
  }

  _close_table_element() {
    if (!this._has_in_table_scope("table")) {
      this._parse_error("unexpected-end-tag", "table");
      return false;
    }
    this._generate_implied_end_tags();
    while (this.openElements.length) {
      const node = this.openElements.pop();
      if (node.name === "table") break;
    }
    this._reset_insertion_mode();
    return true;
  }

  _has_in_scope(name) {
    return this._has_element_in_scope(name, DEFAULT_SCOPE_TERMINATORS);
  }

  _has_in_list_item_scope(name) {
    return this._has_element_in_scope(name, LIST_ITEM_SCOPE_TERMINATORS);
  }

  _has_in_definition_scope(name) {
    return this._has_element_in_scope(name, DEFINITION_SCOPE_TERMINATORS);
  }

  _has_any_in_scope(names) {
    const terminators = DEFAULT_SCOPE_TERMINATORS;
    for (let idx = this.openElements.length - 1; idx >= 0; idx -= 1) {
      const node = this.openElements[idx];
      if (names.has(node.name)) return true;
      if ((node.namespace == null || node.namespace === "html") && terminators.has(node.name)) return false;
    }
    return false;
  }

  _populate_selectedcontent(root) {
    const selects = [];
    this._find_elements(root, "select", selects);
    for (const select of selects) {
      const selectedcontent = this._find_element(select, "selectedcontent");
      if (!selectedcontent) continue;

      const options = [];
      this._find_elements(select, "option", options);
      if (!options.length) continue;

      let selectedOption = null;
      for (const opt of options) {
        const attrs = opt.attrs || {};
        if (Object.prototype.hasOwnProperty.call(attrs, "selected")) {
          selectedOption = opt;
          break;
        }
      }
      if (!selectedOption) selectedOption = options[0];

      this._clone_children(selectedOption, selectedcontent);
    }
  }

  _find_elements(node, name, result) {
    if (!node) return;
    if (node.name === name) result.push(node);

    for (const child of node.children || []) this._find_elements(child, name, result);
    const templateContent = node.templateContent ?? node.template_content ?? null;
    if (templateContent) this._find_elements(templateContent, name, result);
  }

  _find_element(node, name) {
    if (!node) return null;
    if (node.name === name) return node;

    for (const child of node.children || []) {
      const found = this._find_element(child, name);
      if (found) return found;
    }
    const templateContent = node.templateContent ?? node.template_content ?? null;
    if (templateContent) return this._find_element(templateContent, name);
    return null;
  }

  _clone_children(source, target) {
    for (const child of source.children || []) {
      target.append_child(child.cloneNode(true));
    }
  }

  _should_foster_parenting(target, { forTag = null, isText = false } = {}) {
    if (!this.insert_from_table) return false;
    if (!TABLE_FOSTER_TARGETS.has(target.name)) return false;
    if (isText) return true;
    if (forTag && TABLE_ALLOWED_CHILDREN.has(forTag)) return false;
    return true;
  }

  _prepare_foreign_attributes(namespace, attrs) {
    if (!attrs) return {};
    const adjusted = {};
    for (const [name0, value] of Object.entries(attrs)) {
      let name = name0;
      let lowerName = lowerAscii(name);

      if (namespace === "math" && Object.prototype.hasOwnProperty.call(MATHML_ATTRIBUTE_ADJUSTMENTS, lowerName)) {
        name = MATHML_ATTRIBUTE_ADJUSTMENTS[lowerName];
        lowerName = lowerAscii(name);
      } else if (namespace === "svg" && Object.prototype.hasOwnProperty.call(SVG_ATTRIBUTE_ADJUSTMENTS, lowerName)) {
        name = SVG_ATTRIBUTE_ADJUSTMENTS[lowerName];
        lowerName = lowerAscii(name);
      }

      const foreignAdjustment = FOREIGN_ATTRIBUTE_ADJUSTMENTS[lowerName];
      if (foreignAdjustment != null) {
        const [prefix, local] = foreignAdjustment;
        name = prefix ? `${prefix}:${local}` : local;
      }

      adjusted[name] = value;
    }
    return adjusted;
  }

  _node_attribute_value(node, name) {
    const target = lowerAscii(name);
    const attrs = node?.attrs || {};
    for (const [attrName, attrValue] of Object.entries(attrs)) {
      if (lowerAscii(attrName) === target) return attrValue || "";
    }
    return null;
  }

  _is_html_integration_point(node) {
    if (node.namespace === "math" && node.name === "annotation-xml") {
      const encoding = this._node_attribute_value(node, "encoding");
      if (encoding) {
        const encLower = String(encoding).toLowerCase();
        if (encLower === "text/html" || encLower === "application/xhtml+xml") return true;
      }
      return false;
    }
    return HTML_INTEGRATION_POINT_SET.has(integrationPointKey(node.namespace, node.name));
  }

  _is_mathml_text_integration_point(node) {
    if (node.namespace !== "math") return false;
    return MATHML_TEXT_INTEGRATION_POINT_SET.has(integrationPointKey(node.namespace, node.name));
  }

  _should_use_foreign_content(token) {
    const current = this.openElements[this.openElements.length - 1];
    if (current.namespace == null || current.namespace === "html") return false;
    if (token instanceof EOFToken) return false;

    if (this._is_mathml_text_integration_point(current)) {
      if (token instanceof CharacterToken) return false;
      if (token instanceof Tag && token.kind === Tag.START) {
        const nameLower = lowerAscii(token.name);
        if (nameLower !== "mglyph" && nameLower !== "malignmark") return false;
      }
    }

    if (current.namespace === "math" && current.name === "annotation-xml") {
      if (token instanceof Tag && token.kind === Tag.START) {
        if (lowerAscii(token.name) === "svg") return false;
      }
    }

    if (this._is_html_integration_point(current)) {
      if (token instanceof CharacterToken) return false;
      if (token instanceof Tag && token.kind === Tag.START) return false;
    }

    return true;
  }

  _foreign_breakout_font(tag) {
    const attrs = tag.attrs || {};
    for (const name of Object.keys(attrs)) {
      const lowerName = lowerAscii(name);
      if (lowerName === "color" || lowerName === "face" || lowerName === "size") return true;
    }
    return false;
  }

  _pop_until_html_or_integration_point() {
    while (this.openElements.length) {
      const node = this.openElements[this.openElements.length - 1];
      if (node.namespace == null || node.namespace === "html") return;
      if (this._is_html_integration_point(node)) return;
      if (this.fragment_context_element && node === this.fragment_context_element) return;
      this.openElements.pop();
    }
  }

  _adjust_svg_tag_name(name) {
    const lowered = lowerAscii(name);
    return SVG_TAG_NAME_ADJUSTMENTS[lowered] || name;
  }

  _process_foreign_content(token) {
    const current = this.openElements[this.openElements.length - 1];

    if (token instanceof CharacterToken) {
      const raw = token.data || "";
      const cleaned = [];
      let hasNonNullNonWs = false;
      for (const ch of raw) {
        if (ch === "\x00") {
          this._parse_error("invalid-codepoint-in-foreign-content");
          cleaned.push("\ufffd");
          continue;
        }
        cleaned.push(ch);
        if (!"\t\n\f\r ".includes(ch)) hasNonNullNonWs = true;
      }
      const data = cleaned.join("");
      if (hasNonNullNonWs) this.frameset_ok = false;
      this._append_text(data);
      return null;
    }

    if (token instanceof CommentToken) {
      this._append_comment(token.data);
      return null;
    }

    if (!(token instanceof Tag)) return null;

    const nameLower = lowerAscii(token.name);
    if (token.kind === Tag.START) {
      if (FOREIGN_BREAKOUT_ELEMENTS.has(nameLower) || (nameLower === "font" && this._foreign_breakout_font(token))) {
        this._parse_error("unexpected-html-element-in-foreign-content");
        this._pop_until_html_or_integration_point();
        this._reset_insertion_mode();
        return ["reprocess", this.mode, token, true];
      }

      const namespace = current.namespace;
      let adjustedName = token.name;
      if (namespace === "svg") adjustedName = this._adjust_svg_tag_name(token.name);
      const attrs = this._prepare_foreign_attributes(namespace, token.attrs);
      const newTag = new Tag(Tag.START, adjustedName, attrs, token.selfClosing);
      this._insert_element(newTag, { push: !token.selfClosing, namespace });
      return null;
    }

    if (nameLower === "br" || nameLower === "p") {
      this._parse_error("unexpected-html-element-in-foreign-content");
      this._pop_until_html_or_integration_point();
      this._reset_insertion_mode();
      return ["reprocess", this.mode, token, true];
    }

    let idx = this.openElements.length - 1;
    let first = true;
    while (idx >= 0) {
      const node = this.openElements[idx];
      const isHtml = node.namespace == null || node.namespace === "html";
      const nameEq = lowerAscii(node.name) === nameLower;

      if (nameEq) {
        if (this.fragment_context_element && node === this.fragment_context_element) {
          this._parse_error("unexpected-end-tag-in-fragment-context");
          return null;
        }
        if (isHtml) return ["reprocess", this.mode, token, true];
        this.openElements.splice(idx);
        return null;
      }

      if (first) {
        this._parse_error("unexpected-end-tag-in-foreign-content", token.name);
        first = false;
      }

      if (isHtml) return ["reprocess", this.mode, token, true];
      idx -= 1;
    }

    return null;
  }
}
