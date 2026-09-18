import {
  type CssNode,
  List,
  type Rule,
  type StyleSheet,
  generate,
  parse,
  walk,
} from 'css-tree';
import React from 'react';
import { jsx } from 'react/jsx-runtime';
import { sanitizeStyleSheet } from '../tailwind/sanitize-stylesheet.js';
import { downlevelForEmailClients } from '../tailwind/utils/css/downlevel-for-email-clients.js';
import { getCustomProperties } from '../tailwind/utils/css/get-custom-properties.js';
import { sanitizeNonInlinableRules } from '../tailwind/utils/css/sanitize-non-inlinable-rules.js';
import { mapReactTree } from '../tailwind/utils/react/map-react-tree.js';
import { cloneElementWithInlinedStyles } from '../tailwind/utils/tailwindcss/clone-element-with-inlined-styles.js';
import type { EmailElementProps } from '../tailwind/tailwind.js';

/** The shape emitted for a `*.module.scss` by the SCSS esbuild plugin. */
export interface ScssModule {
  css: string;
}

export interface ScssProps {
  /** Compiled stylesheets whose rules should be applied to `children`. */
  sheets: ReadonlyArray<ScssModule | string>;
  children: React.ReactNode;
}

/**
 * Inlines the rules of a stylesheet into the `style` attribute of the elements
 * carrying the matching classes, the way `<Tailwind>` does for utility classes.
 * Email clients strip stylesheets, so a class on its own styles nothing.
 *
 * Rules that cannot be expressed inline — `@media`, `@supports`, pseudo-selectors
 * and descendant selectors — are emitted as a `<style>` inside `<Head>`, and the
 * classes they need are left on the element.
 */
export function Scss({ sheets, children }: ScssProps) {
  const styleSheet = parse(
    sheets.map((sheet) => (typeof sheet === 'string' ? sheet : sheet.css)).join('\n'),
    { context: 'stylesheet' },
  ) as StyleSheet;
  sanitizeStyleSheet(styleSheet);

  const usedClasses = new Set<string>();
  const collectedChildren = mapReactTree(children, (node) => {
    if (React.isValidElement<{ className?: string }>(node) && node.props.className) {
      for (const className of node.props.className.trim().split(/\s+/)) {
        usedClasses.add(className);
      }
    }
    return node;
  });

  const { inlinableRules, nonInlinableRules } = extractScssRulesPerClass(
    styleSheet,
    usedClasses,
  );
  const customProperties = getCustomProperties(styleSheet);

  const nonInlinableNodes = [...new Set(Array.from(nonInlinableRules.values()).flat())];
  const nonInlineStyles: StyleSheet = {
    type: 'StyleSheet',
    children: new List<CssNode>().fromArray(nonInlinableNodes),
  };
  sanitizeNonInlinableRules(nonInlineStyles);
  downlevelForEmailClients(nonInlineStyles);
  forceImportant(nonInlineStyles);

  const hasNonInlineStylesToApply = nonInlinableRules.size > 0;
  let appliedNonInlineStyles = false;

  const mappedChildren = mapReactTree(collectedChildren, (node) => {
    if (!React.isValidElement<EmailElementProps>(node)) return node;

    const elementWithInlinedStyles = cloneElementWithInlinedStyles(
      node as React.ReactElement<EmailElementProps>,
      inlinableRules,
      nonInlinableRules,
      customProperties,
    );
    if (elementWithInlinedStyles.type !== 'head') return elementWithInlinedStyles;

    appliedNonInlineStyles = true;
    const styleElement = jsx('style', {
      dangerouslySetInnerHTML: { __html: generate(nonInlineStyles) },
    });
    return React.cloneElement(
      elementWithInlinedStyles,
      elementWithInlinedStyles.props,
      styleElement,
      elementWithInlinedStyles.props.children,
    );
  });

  if (hasNonInlineStylesToApply && !appliedNonInlineStyles) {
    throw new Error(`Scss: <head> not found inside <Scss>.
Move <Head /> inside <Scss>, or remove these classes that require a <head>: ${Array.from(nonInlinableRules.keys()).join(' ')}.`);
  }

  return mappedChildren;
}

/**
 * Splits the stylesheet the way `extractRulesPerClass` does, but treats only a rule
 * selected by a single bare class as inlinable.
 *
 * Tailwind only ever emits single-class utilities, so its extractor calls any rule
 * without an at-rule or pseudo-selector inlinable. SCSS nesting produces descendant
 * and compound selectors — `.body a { … }` — and crediting those to `.body` would
 * apply a child's declarations to the parent element.
 */
function extractScssRulesPerClass(styleSheet: StyleSheet, usedClasses: Set<string>) {
  const inlinableRules = new Map<string, Rule[]>();
  const nonInlinableRules = new Map<string, Rule[]>();

  const append = (map: Map<string, Rule[]>, className: string, rule: Rule) => {
    const existing = map.get(className);
    if (existing) existing.push(rule);
    else map.set(className, [rule]);
  };

  styleSheet.children.forEach((node) => {
    const lone = node.type === 'Rule' ? loneClassOf(node) : undefined;
    if (lone !== undefined) {
      if (usedClasses.has(lone)) append(inlinableRules, lone, node as Rule);
      return;
    }
    for (const className of classesIn(node)) {
      if (usedClasses.has(className)) append(nonInlinableRules, className, node as Rule);
    }
  });

  return { inlinableRules, nonInlinableRules };
}

/** The class name when every selector of the rule is exactly one class, else undefined. */
function loneClassOf(rule: Rule): string | undefined {
  if (rule.prelude.type !== 'SelectorList') return undefined;

  let name: string | undefined;
  let simple = true;
  rule.prelude.children.forEach((selector) => {
    if (!simple || selector.type !== 'Selector') {
      simple = false;
      return;
    }
    const parts = selector.children.toArray();
    const [only] = parts;
    if (parts.length !== 1 || only?.type !== 'ClassSelector') {
      simple = false;
      return;
    }
    if (name !== undefined && name !== only.name) simple = false;
    name = only.name;
  });

  return simple ? name : undefined;
}

function classesIn(node: CssNode) {
  const names = new Set<string>();
  walk(node, (child) => {
    if (child.type === 'ClassSelector') names.add(child.name);
  });
  return names;
}

/**
 * Forces `!important` on declarations bound for the `<style>` block.
 *
 * Without it they are dead: the same elements carry the `style` attributes this
 * component inlines, and an inline style outranks every normal author rule —
 * specificity, source order and cascade layers alike.
 */
function forceImportant(node: CssNode) {
  walk(node, (child) => {
    if (child.type === 'Declaration') child.important = true;
  });
}
