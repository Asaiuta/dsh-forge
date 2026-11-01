from pathlib import Path
from playwright.sync_api import sync_playwright
import json

out = Path('.dsh/validation/forge-repair')
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:20014', wait_until='networkidle')
    page.screenshot(path=str(out / 'gui-baseline.png'), full_page=True)
    report = {
        'url': page.url,
        'title': page.title(),
        'buttons': page.get_by_role('button').all_text_contents(),
        'body': page.locator('body').inner_text()[:20000],
        'pageErrors': errors,
        'forgeConfig': page.evaluate("async () => { const r = await fetch('/forge-config'); return {status:r.status,body:await r.text()}; }"),
    }
    (out / 'gui-baseline.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    browser.close()
