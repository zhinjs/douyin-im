export interface DesktopDTraitCanvas2D {
  fillStyle: unknown;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  font: string;
  strokeStyle: unknown;
  lineWidth: number;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ): { addColorStop(offset: number, color: string): void };
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}
export interface DesktopDTraitCanvasContext {
  readonly document: {
    createElement(tag: string): {
      width: number;
      height: number;
      getContext(type: string): DesktopDTraitCanvas2D | null;
      toDataURL(): string;
    };
  };
  readonly Math: { PI: number };
  hash(value: unknown): number;
}

/** F207/208: draw to an unattached canvas and hash its actual data URL. */
export function createDesktopDTraitCanvasCollector(
  context: DesktopDTraitCanvasContext
): () => { str_3: number | string } {
  return () => {
    const canvas = context.document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const draw = canvas.getContext('2d');
    if (!draw) return { str_3: '' };
    const gradient = draw.createRadialGradient(200, 100, 20, 200, 100, 180);
    gradient.addColorStop(0, 'rgba(255,0,0,0.5)');
    gradient.addColorStop(0.5, 'rgba(0,255,0,0.5)');
    gradient.addColorStop(1, 'rgba(0,0,255,0.5)');
    draw.fillStyle = gradient;
    draw.fillRect(0, 0, 400, 200);
    draw.shadowColor = 'rgba(50,50,50,0.8)';
    draw.shadowBlur = 10;
    draw.shadowOffsetX = 4;
    draw.shadowOffsetY = 4;
    draw.fillStyle = '#FF5722';
    draw.beginPath();
    draw.arc(150, 75, 40, 0, 2 * context.Math.PI);
    draw.fill();
    draw.fillStyle = '#4CAF50';
    draw.fillRect(50, 100, 100, 30);
    draw.shadowBlur = 0;
    draw.font = "italic 48px 'Comic Sans MS'";
    draw.fillStyle = 'rgba(0, 0, 0, 0.8)';
    draw.fillText('ABCDEFGHIJKL', 0, 40);
    draw.fillText('MNOPQRSTUVWXYZ', 0, 80);
    draw.font = "bold 42px 'Arial'";
    draw.fillStyle = 'rgba(255, 215, 0, 0.6)';
    draw.fillText('abcdefghijklmn', 0, 120);
    draw.fillText('opqrstuvwxyz', 0, 160);
    draw.strokeStyle = 'rgba(0,0,0,0.3)';
    draw.lineWidth = 2;
    for (let x = 0; x < 400; x += 20) {
      draw.beginPath();
      draw.moveTo(x, 0);
      draw.lineTo(x + 20, 200);
      draw.stroke();
      draw.beginPath();
      draw.moveTo(x, 200);
      draw.lineTo(x + 20, 0);
      draw.stroke();
    }
    const url = canvas.toDataURL();
    return { str_3: context.hash(url) || '' };
  };
}

export interface DesktopDTraitDomParent {
  removeChild(node: DesktopDTraitDomElement): unknown;
}
export interface DesktopDTraitDomElement {
  id: string;
  style: { cssText: string };
  readonly parentNode: DesktopDTraitDomParent | null;
  getBoundingClientRect(): {
    width: unknown;
    height: unknown;
    x: unknown;
    y: unknown;
  };
}
export interface DesktopDTraitDomContext {
  readonly document: {
    createElement(tag: string): DesktopDTraitDomElement;
    readonly body: DesktopDTraitDomParent & {
      appendChild(node: DesktopDTraitDomElement): unknown;
    };
    querySelector(selector: string): DesktopDTraitDomElement | null;
  };
  hash(value: unknown): number;
}

/** F225/226. Use only an account-owned document: source ID fallback cleanup may select another matching element. */
export function createDesktopDTraitDomCollector(
  context: DesktopDTraitDomContext
): () => { str_2: number } {
  return () => {
    const element = context.document.createElement('div');
    element.id = 'secure-collect-dom';
    element.style.cssText =
      '\n      position: absolute;\n      top: 0;\n      left: 0;\n      width: 123.45px; \n      height: 67.89px;\n      transform: rotate(45deg) translateX(-200px);\n      visibility: hidden;\n      z-index: -100;\n    ';
    context.document.body.appendChild(element);
    const rect = element.getBoundingClientRect();
    // Source has no finally: measurement failures leave cleanup to eventual realm disposal.
    if (element.parentNode === context.document.body)
      context.document.body.removeChild(element);
    else {
      const found = context.document.querySelector('#secure-collect-dom');
      if (found) found.parentNode?.removeChild(found);
    }
    const { width, height, x, y } = rect;
    return {
      str_2: context.hash(
        ''
          .concat(height as string, ',')
          .concat(width as string, ',')
          .concat(x as string, ',')
          .concat(y as string)
      ),
    };
  };
}
