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
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function safeHttpUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
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
  const content = /* @__PURE__ */ jsxs("span", { className: "tile-content", children: [
    iconUrl && !iconFailed ? /* @__PURE__ */ jsx2(
      "img",
      {
        className: "tile-icon",
        src: iconUrl,
        alt: "",
        loading: "lazy",
        decoding: "async",
        onError: () => setIconFailed(true)
      }
    ) : /* @__PURE__ */ jsx2("span", { className: "tile-placeholder", "aria-hidden": "true", children: name.charAt(0).toUpperCase() }),
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
  return /* @__PURE__ */ jsx2("button", { type: "button", className: classes.join(" "), onClick, children: content });
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
  safeHttpUrl
};
