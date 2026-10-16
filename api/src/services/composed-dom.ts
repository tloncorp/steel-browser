/** DOM traversal follows rendered slots and open shadow roots without reading field values. */
export function createComposedDom() {
  const parent = (element: Element): Element | null => {
    const root = element.getRootNode();
    return (
      element.assignedSlot ||
      element.parentElement ||
      (root instanceof ShadowRoot ? root.host : null)
    );
  };
  const children = (node: Node): Node[] => {
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(
      node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes,
    );
  };
  const elements = (root: Node): Element[] =>
    children(root).flatMap((node) => [
      ...(node instanceof Element ? [node] : []),
      ...elements(node),
    ]);
  const closest = (element: Element | null, selector: string): Element | null => {
    for (let node = element; node; node = parent(node)) if (node.matches(selector)) return node;
    return null;
  };
  const contains = (root: Element, element: Element): boolean => {
    for (let node: Element | null = element; node; node = parent(node))
      if (node === root) return true;
    return false;
  };
  const text = (node: Node | null): string => {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (
      node instanceof Element &&
      node.matches('input, textarea, select, script, style, [aria-hidden="true"]')
    )
      return "";
    return children(node).map(text).join("");
  };
  return { parent, elements, closest, contains, text };
}

export type ComposedDom = ReturnType<typeof createComposedDom>;
