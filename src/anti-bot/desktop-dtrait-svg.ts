export interface DesktopDTraitSvgParent {
  removeChild(node: DesktopDTraitSvgElement): unknown;
}
export interface DesktopDTraitSvgElement {
  id: string;
  readonly parentNode: DesktopDTraitSvgParent | null;
  setAttribute(name: string, value: string): void;
  appendChild(node: DesktopDTraitSvgElement): unknown;
  getBBox(): { x: unknown; y: unknown; width: unknown; height: unknown };
}
export interface DesktopDTraitSvgContext {
  readonly document: {
    createElementNS(namespace: string, tag: string): DesktopDTraitSvgElement;
    readonly body: DesktopDTraitSvgParent & {
      appendChild(node: DesktopDTraitSvgElement): unknown;
    };
    querySelector(selector: string): DesktopDTraitSvgElement | null;
  };
  hash(value: unknown): number;
}

/** F291–292. Only call in the account's isolated browser document; no synthetic geometry fallback. */
export function createDesktopDTraitSvgCollector(
  context: DesktopDTraitSvgContext
): () => Record<string, number> {
  return () => {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = context.document.createElementNS(namespace, 'svg');
    svg.id = 'secure-collect-svg';
    svg.setAttribute('width', '200');
    svg.setAttribute('height', '100');
    svg.setAttribute(
      'style',
      'opacity: 0;position: absolute;top: 0;left: 0;transform: translateX(-200px)'
    );
    const rect = context.document.createElementNS(namespace, 'rect');
    rect.setAttribute('x', '10.5');
    rect.setAttribute('y', '20.25');
    rect.setAttribute('width', '123.45');
    rect.setAttribute('height', '67.89');
    svg.appendChild(rect);
    context.document.body.appendChild(svg);
    const box = rect.getBBox();
    // Source cleanup is after getBBox, not finally: a measurement throw leaves the node for the owning realm to dispose.
    if (svg.parentNode === context.document.body)
      context.document.body.removeChild(svg);
    else {
      const found = context.document.querySelector('#secure-collect-svg');
      if (found) found.parentNode?.removeChild(found);
    }
    const { x, y, width, height } = box;
    return {
      str_24: context.hash(
        ''
          .concat(x as string, ',')
          .concat(y as string, ',')
          .concat(width as string, ',')
          .concat(height as string)
      ),
    };
  };
}
