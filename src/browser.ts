import { chromium, type Browser } from "playwright";

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    _browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
