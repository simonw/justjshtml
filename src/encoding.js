const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

const BYTES_DASH_DASH_GT = new Uint8Array([0x2d, 0x2d, 0x3e]); // -->

const BYTES_META = new Uint8Array([0x6d, 0x65, 0x74, 0x61]); // meta
const BYTES_CHARSET = new Uint8Array([0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74]); // charset
const BYTES_HTTP_EQUIV = new Uint8Array([
  0x68, 0x74, 0x74, 0x70, 0x2d, 0x65, 0x71, 0x75, 0x69, 0x76,
]); // http-equiv
const BYTES_CONTENT = new Uint8Array([0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74]); // content
const BYTES_CONTENT_TYPE = new Uint8Array([
  0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x2d, 0x74, 0x79, 0x70, 0x65,
]); // content-type

function asciiLowerByte(b) {
  if (b >= 0x41 && b <= 0x5a) return b | 0x20;
  return b;
}

function isAsciiAlphaByte(b) {
  const c = asciiLowerByte(b);
  return c >= 0x61 && c <= 0x7a;
}

function skipAsciiWhitespace(data, i) {
  while (i < data.length && ASCII_WHITESPACE.has(data[i])) i += 1;
  return i;
}

function stripAsciiWhitespace(value) {
  if (value == null) return null;
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value[start])) start += 1;
  while (end > start && ASCII_WHITESPACE.has(value[end - 1])) end -= 1;
  return value.subarray(start, end);
}

function asciiDecodeIgnore(bytes) {
  let out = "";
  for (const b of bytes) {
    if (b <= 0x7f) out += String.fromCharCode(b);
  }
  return out;
}

function indexOfByte(data, byte, start) {
  for (let i = start; i < data.length; i += 1) {
    if (data[i] === byte) return i;
  }
  return -1;
}

function indexOfSubarray(data, pattern, start) {
  outer: for (let i = start; i <= data.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (data[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function bytesEqualLower(data, start, end, asciiLowerPattern) {
  const len = end - start;
  if (len !== asciiLowerPattern.length) return false;
  for (let i = 0; i < len; i += 1) {
    if (asciiLowerByte(data[start + i]) !== asciiLowerPattern[i]) return false;
  }
  return true;
}

function bytesEqualIgnoreAsciiCase(data, asciiLowerPattern) {
  if (data.length !== asciiLowerPattern.length) return false;
  for (let i = 0; i < asciiLowerPattern.length; i += 1) {
    if (asciiLowerByte(data[i]) !== asciiLowerPattern[i]) return false;
  }
  return true;
}

export function normalizeEncodingLabel(label) {
  if (!label) return null;

  let s = "";
  if (typeof label === "string") {
    s = label;
  } else if (label instanceof Uint8Array) {
    s = asciiDecodeIgnore(label);
  } else {
    s = String(label);
  }

  s = s.trim();
  if (!s) return null;
  s = s.toLowerCase();

  if (s === "utf-7" || s === "utf7" || s === "x-utf-7") return "windows-1252";
  if (s === "utf-8" || s === "utf8") return "utf-8";

  if (
    s === "iso-8859-1" ||
    s === "iso8859-1" ||
    s === "latin1" ||
    s === "latin-1" ||
    s === "l1" ||
    s === "cp819" ||
    s === "ibm819"
  ) {
    return "windows-1252";
  }

  if (s === "windows-1252" || s === "windows1252" || s === "cp1252" || s === "x-cp1252") return "windows-1252";
  if (s === "iso-8859-2" || s === "iso8859-2" || s === "latin2" || s === "latin-2") return "iso-8859-2";
  if (s === "euc-jp" || s === "eucjp") return "euc-jp";

  if (s === "utf-16" || s === "utf16") return "utf-16";
  if (s === "utf-16le" || s === "utf16le") return "utf-16le";
  if (s === "utf-16be" || s === "utf16be") return "utf-16be";

  return null;
}

function normalizeMetaDeclaredEncoding(label) {
  const enc = normalizeEncodingLabel(label);
  if (enc == null) return null;

  if (
    enc === "utf-16" ||
    enc === "utf-16le" ||
    enc === "utf-16be" ||
    enc === "utf-32" ||
    enc === "utf-32le" ||
    enc === "utf-32be"
  ) {
    return "utf-8";
  }

  return enc;
}

function sniffBOM(data) {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return ["utf-8", 3];
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return ["utf-16le", 2];
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return ["utf-16be", 2];
  return [null, 0];
}

function extractCharsetFromContent(contentBytes) {
  if (contentBytes == null || contentBytes.length === 0) return null;

  const normalized = new Uint8Array(contentBytes.length);
  for (let i = 0; i < contentBytes.length; i += 1) {
    const ch = contentBytes[i];
    normalized[i] = ASCII_WHITESPACE.has(ch) ? 0x20 : asciiLowerByte(ch);
  }

  const charsetNeedle = new Uint8Array([0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74]); // charset
  const idx = indexOfSubarray(normalized, charsetNeedle, 0);
  if (idx === -1) return null;

  let i = idx + charsetNeedle.length;
  const n = normalized.length;
  while (i < n && ASCII_WHITESPACE.has(normalized[i])) i += 1;
  if (i >= n || normalized[i] !== 0x3d) return null; // '='
  i += 1;
  while (i < n && ASCII_WHITESPACE.has(normalized[i])) i += 1;
  if (i >= n) return null;

  let quote = null;
  if (normalized[i] === 0x22 || normalized[i] === 0x27) {
    quote = normalized[i];
    i += 1;
  }

  const start = i;
  while (i < n) {
    const ch = normalized[i];
    if (quote != null) {
      if (ch === quote) break;
    } else if (ASCII_WHITESPACE.has(ch) || ch === 0x3b) {
      break;
    }
    i += 1;
  }

  if (quote != null && (i >= n || normalized[i] !== quote)) return null;

  return normalized.subarray(start, i);
}

function prescanForMetaCharset(data) {
  const maxNonComment = 1024;
  const maxTotalScan = 65536;

  const n = data.length;
  let i = 0;
  let nonComment = 0;

  while (i < n && i < maxTotalScan && nonComment < maxNonComment) {
    if (data[i] !== 0x3c) {
      i += 1;
      nonComment += 1;
      continue;
    }

    // Comment <!-- ... -->
    if (i + 3 < n && data[i + 1] === 0x21 && data[i + 2] === 0x2d && data[i + 3] === 0x2d) {
      const end = indexOfSubarray(data, BYTES_DASH_DASH_GT, i + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }

    // Tag open
    let j = i + 1;

    // End tag: skip it.
    if (j < n && data[j] === 0x2f) {
      let k = i;
      let quote = null;
      while (k < n && k < maxTotalScan && nonComment < maxNonComment) {
        const ch = data[k];
        if (quote == null) {
          if (ch === 0x22 || ch === 0x27) quote = ch;
          else if (ch === 0x3e) {
            k += 1;
            nonComment += 1;
            break;
          }
        } else if (ch === quote) {
          quote = null;
        }
        k += 1;
        nonComment += 1;
      }
      i = k;
      continue;
    }

    if (j >= n || !isAsciiAlphaByte(data[j])) {
      i += 1;
      nonComment += 1;
      continue;
    }

    const nameStart = j;
    while (j < n && isAsciiAlphaByte(data[j])) j += 1;

    if (!bytesEqualLower(data, nameStart, j, BYTES_META)) {
      // Skip rest of tag (with quote handling) to avoid interpreting '<' inside attrs.
      let k = i;
      let quote = null;
      while (k < n && k < maxTotalScan && nonComment < maxNonComment) {
        const ch = data[k];
        if (quote == null) {
          if (ch === 0x22 || ch === 0x27) quote = ch;
          else if (ch === 0x3e) {
            k += 1;
            nonComment += 1;
            break;
          }
        } else if (ch === quote) {
          quote = null;
        }
        k += 1;
        nonComment += 1;
      }
      i = k;
      continue;
    }

    // Parse attributes until '>'.
    let charset = null;
    let httpEquiv = null;
    let content = null;

    let k = j;
    let sawGt = false;
    const startI = i;

    while (k < n && k < maxTotalScan) {
      const ch = data[k];
      if (ch === 0x3e) {
        sawGt = true;
        k += 1;
        break;
      }

      if (ch === 0x3c) break;

      if (ASCII_WHITESPACE.has(ch) || ch === 0x2f) {
        k += 1;
        continue;
      }

      const attrStart = k;
      while (k < n) {
        const c = data[k];
        if (ASCII_WHITESPACE.has(c) || c === 0x3d || c === 0x3e || c === 0x2f || c === 0x3c) break;
        k += 1;
      }
      const attrEnd = k;
      k = skipAsciiWhitespace(data, k);

      let value = null;
      if (k < n && data[k] === 0x3d) {
        k += 1;
        k = skipAsciiWhitespace(data, k);
        if (k >= n) break;

        const q = data[k];
        if (q === 0x22 || q === 0x27) {
          const quote = q;
          k += 1;
          const valStart = k;
          const endQuote = indexOfByte(data, quote, k);
          if (endQuote === -1) {
            // Unclosed quote: ignore this meta.
            i += 1;
            nonComment += 1;
            charset = null;
            httpEquiv = null;
            content = null;
            sawGt = false;
            break;
          }
          value = data.subarray(valStart, endQuote);
          k = endQuote + 1;
        } else {
          const valStart = k;
          while (k < n) {
            const c = data[k];
            if (ASCII_WHITESPACE.has(c) || c === 0x3e || c === 0x3c) break;
            k += 1;
          }
          value = data.subarray(valStart, k);
        }
      }

      if (bytesEqualLower(data, attrStart, attrEnd, BYTES_CHARSET)) charset = stripAsciiWhitespace(value);
      else if (bytesEqualLower(data, attrStart, attrEnd, BYTES_HTTP_EQUIV)) httpEquiv = value;
      else if (bytesEqualLower(data, attrStart, attrEnd, BYTES_CONTENT)) content = value;
    }

    if (sawGt) {
      if (charset && charset.length) {
        const enc = normalizeMetaDeclaredEncoding(charset);
        if (enc) return enc;
      }

      if (httpEquiv && bytesEqualIgnoreAsciiCase(httpEquiv, BYTES_CONTENT_TYPE) && content) {
        const extracted = extractCharsetFromContent(content);
        if (extracted) {
          const enc = normalizeMetaDeclaredEncoding(extracted);
          if (enc) return enc;
        }
      }

      i = k;
      const consumed = i - startI;
      nonComment += consumed;
    } else {
      i += 1;
      nonComment += 1;
    }
  }

  return null;
}

export function sniffHTMLEncoding(data, { transportEncoding = null } = {}) {
  const transport = normalizeEncodingLabel(transportEncoding);
  if (transport) return { encoding: transport, bomLength: 0 };

  const [bomEnc, bomLength] = sniffBOM(data);
  if (bomEnc) return { encoding: bomEnc, bomLength };

  const metaEnc = prescanForMetaCharset(data);
  if (metaEnc) return { encoding: metaEnc, bomLength: 0 };

  return { encoding: "windows-1252", bomLength: 0 };
}

export function decodeHTML(data, { transportEncoding = null } = {}) {
  const { encoding, bomLength } = sniffHTMLEncoding(data, { transportEncoding });

  let enc = encoding;
  if (
    enc !== "utf-8" &&
    enc !== "windows-1252" &&
    enc !== "iso-8859-2" &&
    enc !== "euc-jp" &&
    enc !== "utf-16" &&
    enc !== "utf-16le" &&
    enc !== "utf-16be"
  ) {
    enc = "windows-1252";
  }

  let payload = data;
  if (bomLength) payload = data.subarray(bomLength);

  if (enc === "utf-16") {
    const [bomEnc, bomLen] = sniffBOM(payload);
    if (bomEnc === "utf-16le" || bomEnc === "utf-16be") {
      payload = payload.subarray(bomLen);
      const text = new TextDecoder(bomEnc).decode(payload);
      return { text, encoding: enc };
    }
    const text = new TextDecoder("utf-16le").decode(payload);
    return { text, encoding: enc };
  }

  const text = new TextDecoder(enc).decode(payload);
  return { text, encoding: enc };
}

