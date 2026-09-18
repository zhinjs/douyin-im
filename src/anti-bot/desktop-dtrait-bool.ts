// Pinned core string 350; never substitute another pixel or an external URL.
const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFUAAABUCAYAAADzqXv/AAAACXBIWXMAACE4AAAhOAFFljFgAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAALASURBVHgB7ZyJUsJAEEQHBK///1UvQNS2dmGL4sgm3cui/apiqjQmzcvM5tQIY4wxxhhjzL9gFtcB270r5vPYZ3mJvkHORZoj9136/vZneov0wxbkjS9iL/NWKHOXO/8kSqk5zDLqJGLZr7geuRJz/qHZd8uxpY4VebiOTbQH20XuGpElszR9saSiLR5jP77cEsj8EJzsFKmzFGgZPFpVqqIQsM7tFKn4XYRiH3RaHMTu0yTJPkaqojpLlEOIepjCete1UhHqKc1VqCoVH/gptJ1QXakQ+Rz69twdRYMHuuox9PwW21CprYRmmFIxVN1HG+a7LwMWbCk0b5NBS6GZ2aVKbS0U18+faT4VfLaWQj/TdLb9IVI9sINNCrMOXsvno7yaTTHtsp+TitZRHuURZBVp75JRF8M6TUezn5K6DN15KFr7PTQygbIYUAgfcWF4OiYVe1g1Fq3SpLoLBZmK7MgLmeshCx+TilDsPY1QqE71Nb1CaL75PPjgeShVsaerQ40k37pjgsyvUdlZh1LZQhGmOtRIHoLLKKGgbPP8vIgJxqEWQstnRSxGF0MpdRHcsTSfdrSA3WGTiqGUyB6PPqIdzCpF269iAvNizgzGvDq6BLvDJgkFOQx7PJocrAL2w8vJp30KqdvQnz6VdNdhCqmqy89j5LdEWFCy5zcumMFaPrNnX/nRpLKDtWz9LrMrpLZ8ZYd9LKDAPh0JwvpqWpCdfcpOQjH97pix7w2d4znGg1A1r1Iys+dHR2PBmcN7XpHy7r6aLrMPet+yU7rNbakCbllqt9zyeNp1pRoylirAUgVYqgBLFWCpAixVgKUKsFQBlirAUgVYqgBLFWCpAixVgKUKsFQBlirAUgVYqgBLFWCpAixVgKUKsFQBlirAUgXgpd9r/LPCU9S82o5le8re8q9yjDHGGGOMMeaP8g1FVWaArDlxQQAAAABJRU5ErkJggg==';

export interface DesktopDTraitImageProbe {
  id: string;
  src: string;
  style: { cssText: string };
  readonly parentNode: {
    removeChild(node: DesktopDTraitImageProbe): unknown;
  } | null;
}
export interface DesktopDTraitBoolContext {
  readonly document: {
    createElement(tag: string): DesktopDTraitImageProbe;
    readonly body: { appendChild(node: DesktopDTraitImageProbe): unknown };
    getElementById(
      id: string
    ): { onload: (() => void) | null; onerror: (() => void) | null } | null;
    getElementsByClassName(name: string): { readonly length: number };
    createEvent(name: string): unknown;
  };
  readonly navigator: {
    brave?: unknown;
    cookieEnabled?: unknown;
    doNotTrack?: unknown;
    pdfViewerEnabled?: unknown;
    serviceWorker?: unknown;
    webdriver?: unknown;
  };
  readonly RTCPeerConnection?: (new () => unknown) | undefined;
  readonly Date: { now(): number };
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
  onDiagnostic(code: 'bool'): void;
}
export type DesktopDTraitBoolFeature =
  `bool_${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;

/** F179–206. Must run in an isolated account-owned realm, never an arbitrary user document. */
export function createDesktopDTraitBoolCollector(
  context: DesktopDTraitBoolContext
) {
  const imageDisable = () => {
    const started = context.Date.now();
    return new Promise<{
      imageDisable: 0 | 1;
      duration_time_imageDisable: number;
    }>(resolve => {
      const image = context.document.createElement('img');
      image.id = 'image_disable';
      image.style.cssText = '\n    display: none;\n    ';
      image.src = IMAGE_DATA_URL;
      context.document.body.appendChild(image);
      const found = context.document.getElementById('image_disable');
      const finish = (disabled: 0 | 1) => {
        if (image.parentNode) image.parentNode.removeChild(image);
        resolve({
          imageDisable: disabled,
          duration_time_imageDisable: context.Date.now() - started,
        });
      };
      const timer = context.setTimeout(() => finish(1), 500);
      if (!found) {
        context.clearTimeout(timer);
        finish(0);
        return;
      }
      found.onload = () => {
        context.clearTimeout(timer);
        finish(0);
      };
      found.onerror = () => {
        context.clearTimeout(timer);
        finish(1);
      };
    });
  };
  const rtcDisable = () => {
    try {
      const RTC = context.RTCPeerConnection!;
      new RTC();
      return Promise.resolve(0 as const);
    } catch {
      return Promise.resolve(1 as const);
    }
  };
  const automa = () =>
    context.document.getElementsByClassName('automa-element-selector').length >
      0 || Boolean(context.document.getElementById('automa-palette'))
      ? 1
      : 0;
  const touch = () => {
    try {
      context.document.createEvent('TouchEvent');
      return 1;
    } catch {
      return 0;
    }
  };
  return async (): Promise<Record<DesktopDTraitBoolFeature, number>> => {
    const image = imageDisable();
    // Hosting safeguard: a later synchronous helper throw must not strand a rejected image Promise.
    // This observer does not replace the original Promise, result, cleanup or F206 catch boundary.
    void image.catch(() => undefined);
    return Promise.all([image, rtcDisable(), automa(), touch()])
      .then(([imageValue, rtc, automation, touchValue]) => ({
        bool_1: automation,
        bool_2: imageValue.imageDisable,
        bool_3: context.navigator.brave ? 1 : 0,
        bool_4: context.navigator.cookieEnabled ? 1 : 0,
        bool_5: context.navigator.doNotTrack ? 1 : 0,
        bool_6: context.navigator.pdfViewerEnabled ? 1 : 0,
        bool_7: context.navigator.serviceWorker ? 1 : 0,
        bool_8: context.navigator.webdriver ? 1 : 0,
        bool_9: touchValue,
        bool_10: rtc,
      }))
      .catch(error => {
        context.onDiagnostic('bool');
        return Promise.reject(error);
      });
  };
}
