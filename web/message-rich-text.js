export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function prepareMarkdownSource(text, options = {}) {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return "";
  }

  let prepared = raw.replace(/\r\n?/g, "\n");

  // 1) 让常见块级结构尽量提前成型
  // 普通文本后面直接接列表 / 引用 / 代码块 / 标题时，补一个空行
  prepared = prepared.replace(
    /([^\n])\n(?=(?:\s{0,3}(?:[-*+]|\d+\.)\s+|\s{0,3}>|\s{0,3}```|\s{0,3}#{1,6}\s))/g,
    "$1\n\n",
  );

  if (!options.streaming) {
    return prepared;
  }

  // 2) streaming 时，补全未闭合 fence
  const fenceMatches = prepared.match(/^\s*```.*$/gm) || [];
  if (fenceMatches.length % 2 === 1) {
    prepared += "\n```";
  }

  // 3) streaming 时，补全未闭合行内 code
  const backtickCount = (prepared.match(/`/g) || []).length;
  if (backtickCount % 2 === 1) {
    prepared += "`";
  }

  // 4) streaming 时，补全未闭合粗体 **
  // 只做最常见场景，避免过度魔改
  const doubleStarCount = (prepared.match(/\*\*/g) || []).length;
  if (doubleStarCount % 2 === 1) {
    prepared += "**";
  }

  // 5) streaming 时，补全未闭合单星号 *
  // 这里做保守处理：排除已经被 ** 吃掉的情况
  const singleStarLike = prepared.replace(/\*\*/g, "");
  const singleStarCount = (singleStarLike.match(/\*/g) || []).length;
  if (singleStarCount % 2 === 1) {
    prepared += "*";
  }

  // 6) 末尾如果停在 blockquote 行内，保留块语义更稳定
  // （这里不强补 >，只确保 blockquote 前已经断段）
  prepared = prepared.replace(/([^\n])\n(?=\s{0,3}>\s?)/g, "$1\n\n");

  return prepared;
}

function renderPlainText(text, options) {
  const value = String(text || "");
  if (!value) {
    return "";
  }
  if (typeof options.renderText === "function") {
    return options.renderText(value);
  }
  return escapeHtml(value);
}

function renderCodeText(text, options) {
  const value = String(text || "");
  if (!value) {
    return "";
  }
  if (typeof options.renderCodeText === "function") {
    return options.renderCodeText(value);
  }
  return renderPlainText(value, options);
}

function sanitizeHref(href) {
  const value = String(href || "").trim();
  if (!value) {
    return null;
  }

  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("#") ||
    /^https?:\/\//i.test(value)
  ) {
    return value;
  }

  return null;
}

function getMarkdownItFactory() {
  const factory = globalThis.markdownit;
  if (typeof factory !== "function") {
    throw new Error("markdown-it is not loaded.");
  }
  return factory;
}

function renderDefaultCodeBlock(block, options) {
  const lang = String(block.lang || "").trim() || "text";
  const code = String(block.text || "").replace(/\n$/, "");
  return `<div class="msg-md-code-block"><pre class="msg-md-pre"><code class="msg-md-code">${renderCodeText(code, options)}</code></pre></div>`;
}

function createMarkdownRenderer(options) {
  const MarkdownIt = getMarkdownItFactory();
  const md = MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
  });

  md.validateLink = (url) => Boolean(sanitizeHref(url));

  const linkStack = [];

  md.renderer.rules.paragraph_open = () => '<p class="msg-md-p">';
  md.renderer.rules.paragraph_close = () => "</p>";
  md.renderer.rules.bullet_list_open = () => '<ul class="msg-md-ul">';
  md.renderer.rules.bullet_list_close = () => "</ul>";
  md.renderer.rules.ordered_list_open = () => '<ol class="msg-md-ol">';
  md.renderer.rules.ordered_list_close = () => "</ol>";
  md.renderer.rules.list_item_open = () => '<li class="msg-md-li">';
  md.renderer.rules.list_item_close = () => "</li>";
  md.renderer.rules.blockquote_open = () => '<blockquote class="msg-md-bq">';
  md.renderer.rules.blockquote_close = () => "</blockquote>";
  md.renderer.rules.softbreak = () => "<br>";
  md.renderer.rules.hardbreak = () => "<br>";
  md.renderer.rules.text = (tokens, idx) => renderPlainText(tokens[idx].content || "", options);
  md.renderer.rules.code_inline = (tokens, idx) =>
    `<code class="msg-md-code-inline">${renderCodeText(tokens[idx].content || "", options)}</code>`;

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const block = {
      lang: String(token.info || "").trim(),
      text: token.content || "",
    };
    if (typeof options.renderCodeBlock === "function") {
      return options.renderCodeBlock(block, {
        escapeHtml,
        renderCodeText: (value) => renderCodeText(value, options),
      });
    }
    return renderDefaultCodeBlock(block, options);
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    const block = {
      lang: "",
      text: token.content || "",
    };
    if (typeof options.renderCodeBlock === "function") {
      return options.renderCodeBlock(block, {
        escapeHtml,
        renderCodeText: (value) => renderCodeText(value, options),
      });
    }
    return renderDefaultCodeBlock(block, options);
  };

  md.renderer.rules.link_open = (tokens, idx) => {
    const href = sanitizeHref(tokens[idx].attrGet("href"));
    if (!href) {
      linkStack.push("span");
      return '<span class="msg-md-a">';
    }

    linkStack.push("a");
    return `<a class="msg-md-a" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">`;
  };

  md.renderer.rules.link_close = () => {
    const tag = linkStack.pop() || "a";
    return tag === "span" ? "</span>" : "</a>";
  };

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const alt = token.content || token.attrGet("alt") || "";
    return renderPlainText(alt, options);
  };

  return md;
}

let defaultRenderer = null;

function getDefaultRenderer() {
  if (!defaultRenderer) {
    defaultRenderer = createMarkdownRenderer({});
  }
  return defaultRenderer;
}

export function renderRichText(text, options = {}) {
  const source = prepareMarkdownSource(text, options);
  if (!source) return "";

  const renderer =
    Object.keys(options).length === 0 ? getDefaultRenderer() : createMarkdownRenderer(options);

  return renderer.render(source);
}