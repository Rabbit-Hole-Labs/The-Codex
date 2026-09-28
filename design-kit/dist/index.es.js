// src/ThemeProvider.tsx
import { jsx } from "react/jsx-runtime";
function ThemeProvider({
  theme = "dark",
  accent = "slate",
  children,
  className,
  style
}) {
  const classes = ["codex-root", theme];
  if (className) classes.push(className);
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: classes.join(" "),
      "data-accent": accent !== "slate" ? accent : void 0,
      style,
      children
    }
  );
}

// src/LinkTile.tsx
import * as React from "react";

// ../javascript/features/iconPolicy.js
var ALLOWED_ICON_HOSTS = ["cdn.jsdelivr.net", "selfh.st"];
function validateIconValue(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "default") {
    return { valid: true, value: "default" };
  }
  if (/^data:/i.test(trimmed)) {
    return validateDataUrl(trimmed) ? { valid: true, value: trimmed } : { valid: false, reason: "Data-URI icons must be base64 PNG, JPEG, GIF, or SVG under 100KB." };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, reason: "Icon must be a full https:// URL or a data: image URI." };
  }
  const host = url.hostname.toLowerCase();
  const hostAllowed = url.protocol === "https:" && ALLOWED_ICON_HOSTS.some((h) => host === h || host.endsWith("." + h));
  if (!hostAllowed) {
    return {
      valid: false,
      reason: `Icons can only load from selfh.st or jsDelivr \u2014 "${host}" would be blocked by the extension's security policy. Use the Icon picker, or paste a data: image URI.`
    };
  }
  return { valid: true, value: trimmed };
}
function validateDataUrl(dataUrl) {
  try {
    const dataUrlRegex = /^data:image\/(png|jpg|jpeg|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
    return dataUrlRegex.test(dataUrl) && dataUrl.length < 1e5;
  } catch {
    return false;
  }
}

// ../javascript/features/utils.js
function validateAndSanitizeUrl(url) {
  if (!url || typeof url !== "string") {
    return "#";
  }
  try {
    const trimmedUrl = url.trim();
    const urlObj = new URL(trimmedUrl);
    const allowedSchemes = ["http:", "https:"];
    if (!allowedSchemes.includes(urlObj.protocol)) {
      console.warn(`Blocked dangerous URL scheme: ${urlObj.protocol}`);
      return "#";
    }
    const suspiciousDomains = [
      "bit.ly",
      "tinyurl.com",
      "short.link",
      "suspicious-domain.com",
      "malware.com",
      "phishing.com",
      "fake-site.com"
    ];
    const hostname = urlObj.hostname.toLowerCase();
    if (suspiciousDomains.some((domain) => hostname.includes(domain))) {
      console.warn(`Blocked suspicious domain: ${hostname}`);
      return "#";
    }
    return urlObj.href;
  } catch (error) {
    console.warn(`Invalid URL format: ${url}`, error);
    return "#";
  }
}

// src/LinkTile.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function safeHttpUrl(url) {
  if (!url) return null;
  const safe = validateAndSanitizeUrl(url);
  return safe === "#" ? null : safe;
}
function safeIconUrl(iconUrl) {
  if (!iconUrl) return null;
  const result = validateIconValue(iconUrl);
  return result.valid && result.value !== "default" ? result.value : null;
}
function initialOf(name) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  let first;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(void 0, { granularity: "grapheme" });
    first = seg.segment(trimmed)[Symbol.iterator]().next().value?.segment;
  }
  return (first ?? Array.from(trimmed)[0] ?? "").toUpperCase();
}
function LinkTile({
  name,
  url,
  iconUrl,
  size = "medium",
  className,
  onClick
}) {
  const [iconFailed, setIconFailed] = React.useState(false);
  React.useEffect(() => setIconFailed(false), [iconUrl]);
  const classes = ["link-tile", `size-${size}`];
  if (className) classes.push(className);
  const iconSrc = safeIconUrl(iconUrl);
  const content = /* @__PURE__ */ jsxs("span", { className: "tile-content", children: [
    iconSrc && !iconFailed ? /* @__PURE__ */ jsx2(
      "img",
      {
        className: "tile-icon",
        src: iconSrc,
        alt: "",
        loading: "lazy",
        decoding: "async",
        onError: () => setIconFailed(true)
      }
    ) : /* @__PURE__ */ jsx2("span", { className: "tile-placeholder", "aria-hidden": "true", children: initialOf(name) }),
    /* @__PURE__ */ jsx2("h3", { children: name })
  ] });
  const href = safeHttpUrl(url);
  if (href) {
    return /* @__PURE__ */ jsx2(
      "a",
      {
        className: classes.join(" "),
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        onClick,
        children: content
      }
    );
  }
  if (onClick) {
    return /* @__PURE__ */ jsx2("button", { type: "button", className: classes.join(" "), onClick, children: content });
  }
  classes.push("is-static");
  return /* @__PURE__ */ jsx2("div", { className: classes.join(" "), children: content });
}

// src/CategorySection.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function CategorySection({
  title,
  children,
  view = "grid",
  className
}) {
  const sectionClasses = ["category-section"];
  if (className) sectionClasses.push(className);
  const gridClasses = ["links-grid"];
  if (view === "list") gridClasses.push("list-view");
  return /* @__PURE__ */ jsxs2("section", { className: sectionClasses.join(" "), children: [
    /* @__PURE__ */ jsx3("h2", { children: title }),
    /* @__PURE__ */ jsx3("div", { className: gridClasses.join(" "), children })
  ] });
}

// src/SearchBar.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function SearchBar({
  placeholder = "Search...",
  value,
  defaultValue,
  onChange,
  className
}) {
  const classes = ["search-section"];
  if (className) classes.push(className);
  return /* @__PURE__ */ jsx4("div", { className: classes.join(" "), children: /* @__PURE__ */ jsxs3("div", { className: "search-input-wrapper", children: [
    /* @__PURE__ */ jsxs3(
      "svg",
      {
        className: "search-icon",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: [
          /* @__PURE__ */ jsx4("circle", { cx: "11", cy: "11", r: "8" }),
          /* @__PURE__ */ jsx4("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })
        ]
      }
    ),
    /* @__PURE__ */ jsx4(
      "input",
      {
        type: "search",
        className: "search-input",
        placeholder,
        value,
        defaultValue,
        onChange,
        "aria-label": "Search"
      }
    )
  ] }) });
}

// src/Button.tsx
import { jsx as jsx5 } from "react/jsx-runtime";
function Button({
  variant = "primary",
  children,
  className,
  type = "button",
  ...rest
}) {
  const classes = ["codex-button"];
  if (variant !== "secondary") classes.push(variant);
  if (className) classes.push(className);
  return /* @__PURE__ */ jsx5("button", { type, className: classes.join(" "), ...rest, children });
}
export {
  Button,
  CategorySection,
  LinkTile,
  SearchBar,
  ThemeProvider,
  safeHttpUrl,
  safeIconUrl
};
