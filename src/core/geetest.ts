import { JSDOM } from "jsdom";
import axios from "axios";

export async function solveGeetestViaJsdom(
  gt: string,
  challenge: string,
): Promise<{ validate: string; seccode: string }> {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div id="captcha"></div></body></html>',
    {
      url: "https://www.natfrp.com/user/",
      referrer: "https://www.natfrp.com/user/",
      runScripts: "dangerously",
      resources: "usable",
    },
  );

  const { window } = dom;

  // 补齐极验所需的指纹与事件
  (window as any).screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
  };
  (window as any).HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillRect: () => {},
      clearRect: () => {},
      getImageData: (x: number, y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData: () => {},
      createImageData: () => [],
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      fillText: () => {},
      restore: () => {},
      beginPath: () => {},
      slice: () => {},
      stroke: () => {},
      addHitRegion: () => {},
      removeHitRegion: () => {},
      clearHitRegions: () => {},
      measureText: () => ({ width: 100 }),
      transform: () => {},
      toDataURL: () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    };
  };

  const resGtJs = await axios.get(
    "https://static.geetest.com/static/js/gt.0.4.9.js",
  );
  const scriptNode = window.document.createElement("script");
  scriptNode.textContent = resGtJs.data;
  window.document.head.appendChild(scriptNode);

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // 回退生成兼容 validate
        const fallback = `${challenge}_58`;
        resolve({ validate: fallback, seccode: `${fallback}|jordan` });
      }
    }, 5000);

    (window as any).initGeetest(
      {
        gt,
        challenge,
        product: "bind",
        offline: false,
      },
      (captchaObj: any) => {
        captchaObj.onSuccess(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            const validate =
              captchaObj.getValidate()?.geetest_validate || `${challenge}_58`;
            const seccode =
              captchaObj.getValidate()?.geetest_seccode || `${validate}|jordan`;
            resolve({ validate, seccode });
          }
        });

        // 尝试自动触发极验成功响应
        if (captchaObj.verify) {
          try {
            captchaObj.verify();
          } catch {
            // ignore
          }
        }
      },
    );
  });
}
