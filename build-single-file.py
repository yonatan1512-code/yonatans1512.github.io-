# -*- coding: utf-8 -*-
"""Merge index.html + dashboard.html into one self-contained file."""
import io, os, sys, re

ROOT = r"C:\Users\Yonatan\OneDrive\Desktop\YONATAN AI"
OUT = os.path.join(ROOT, "smartsaver-ai-complete.html")

index = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
dash = io.open(os.path.join(ROOT, "dashboard.html"), encoding="utf-8").read()
supa = io.open(os.path.join(ROOT, "supabase", "ss-supabase.js"), encoding="utf-8").read()

fails = []
def rep(text, old, new, expect=None, label=""):
    n = text.count(old)
    if n == 0 or (expect is not None and n != expect):
        fails.append("%s: found %d (expected %s)" % (label or old[:60], n, expect))
        return text
    return text.replace(old, new)

# ---------- split the dashboard document ----------
b0 = dash.index("<body>") + len("<body>")
s0 = dash.index("<script>", b0)
markup = dash[b0:s0]
js = dash[s0 + len("<script>"): dash.rindex("</script>")]
css = dash[dash.index("<style>") + len("<style>"): dash.index("</style>")]

# ---------- CSS: drop what index already owns, scope what would leak ----------
i = css.index("  :root{")
j = css.index("\n  }\n", i) + len("\n  }\n")
css = css[:i] + "  :root{ --green:#3DDC97; --red:#FF7A7A; }\n" + css[j:]

reset_old = """  *{box-sizing:border-box;}
  /* our flex/grid rules would otherwise beat the UA's [hidden] rule */
  [hidden]{display:none !important;}
  html{scroll-behavior:smooth;}
  body{
    margin:0; min-height:100vh;"""
reset_new = """  /* our flex/grid rules would otherwise beat the UA's [hidden] rule */
  [hidden]{display:none !important;}
  #dashboardPage{
    display:none; min-height:100vh;"""
css = rep(css, reset_old, reset_new, 1, "css:body->#dashboardPage")

css = rep(css, "  html.theme-dark body{", "  html.theme-dark #dashboardPage{", 1, "css:dark body")

drop = """  h1,h2,h3,.display{font-family:'Rubik','Arial Hebrew',Arial,sans-serif; font-weight:800; letter-spacing:-0.01em; margin:0;}
  p{margin:0;}
  a{color:inherit; text-decoration:none;}
  button{font-family:inherit; cursor:pointer; border:none;}
  input{font-family:inherit;}
  svg{display:block;}
"""
css = rep(css, drop, "", 1, "css:element resets")

rpm = """
  @media (prefers-reduced-motion: reduce){
    *{animation-duration:0.001ms !important; animation-iteration-count:1 !important; transition-duration:0.001ms !important;}
  }
"""
css = rep(css, rpm, "", 1, "css:reduced-motion")

a11y_start = "  /* ===== ACCESSIBILITY (mirrors the landing page's panel) ===== */"
a11y_end = "html.a11y-stop-motion *{animation:none !important; transition:none !important;}"
ia, ja_ = css.index(a11y_start), css.index(a11y_end) + len(a11y_end)
css = css[:ia] + css[ja_:]

# scoped renames — these class names also exist on the landing page
for old, new, cnt in [
    (".container{max-width:1240px; margin:0 auto; padding:0 28px;}", ".dash-container{max-width:1240px; margin:0 auto; padding:0 28px;}", 1),
    (".container{padding:0 18px;}", ".dash-container{padding:0 18px;}", 1),
    (".btn-primary", ".dash-btn", None),
    (".chart-legend", ".dash-legend", None),
    (".formula{", ".dash-formula{", 1),
    ("  .tag{", "  .dash-tag{", 1),
    (".tag.gold{", ".dash-tag.gold{", 1),
    (".tag.good{", ".dash-tag.good{", 1),
    (".tag.bad{", ".dash-tag.bad{", 1),
    ("\n  footer{", "\n  .dash-footer{", 1),
    ("\n  footer a{", "\n  .dash-footer a{", 1),
]:
    css = rep(css, old, new, cnt, "css:" + old[:40])

# the dashboard replaces the whole page while it is open
css += """
  /* ===== SINGLE-FILE ROUTING: the dashboard takes over the viewport ===== */
  html.show-dashboard #dashboardPage{display:block;}
  html.show-dashboard .nav,
  html.show-dashboard #sectionPager,
  html.show-dashboard #stats,
  html.show-dashboard .side-nav-wrap,
  html.show-dashboard .account-dropdown,
  html.show-dashboard body > footer{display:none !important;}
  html.show-dashboard body{background:transparent;}
"""

# ---------- markup ----------
markup = rep(markup, 'class="container', 'class="dash-container', None, "html:container")
markup = rep(markup, 'class="btn-primary"', 'class="dash-btn"', None, "html:btn")
markup = rep(markup, 'class="chart-legend"', 'class="dash-legend"', 1, "html:legend")
markup = rep(markup, 'class="formula" id="bdFormula"', 'class="dash-formula" id="bdFormula"', 1, "html:formula")
markup = rep(markup, "<footer>", '<footer class="dash-footer">', 1, "html:footer")
# in-page links instead of a second document
markup = rep(markup, 'href="index.html#cta"', 'href="#cta" data-dash-exit', 1, "html:cta link")
markup = markup.replace('href="index.html#simulator"', 'href="#simulator" data-dash-exit')
markup = markup.replace('href="index.html"', 'href="#hero" data-dash-exit')

if '<div id="dashboardPage">' not in markup:
    fails.append("markup: missing #dashboardPage wrapper")
markup = "\n" + markup.strip() + "\n"

# ---------- JS ----------
for old, new in [('class="tag good"', 'class="dash-tag good"'),
                 ('class="tag gold"', 'class="dash-tag gold"'),
                 ('class="tag bad"', 'class="dash-tag bad"'),
                 ('class="tag"', 'class="dash-tag"')]:
    js = js.replace(old, new)

js = rep(js, "boot();", """
/* ---------- single-file routing ---------- */
function refresh(){
  const ok = loadRecord() && record.goalCost !== undefined;
  $('lockedView').hidden = ok;
  $('dashView').hidden = !ok;
  $('userChip').hidden = !ok;
  // opening the dashboard is exactly when the other device's numbers matter
  if(ok) syncFromCloud(); else cloudRescue();
  if(ok){
    $('userAvatar').textContent = (email.trim().charAt(0) || '?').toUpperCase();
    paintProviderBadge();
    $('userMail').textContent = email;
    $('greeting').textContent = t('dash.hello', { name: email.split('@')[0] });
    $('depCur').textContent = cur();
    buildQuickAmounts();
    render();
  }
}

const siteTitle = document.title;
function openDash(){
  // the signup takeover is fixed and locks scrolling — it must let go first
  document.documentElement.classList.remove('signup-mode');
  document.documentElement.classList.add('show-dashboard');
  document.title = 'SmartSaver AI \\u2014 ' + t('dash.title');
  if(location.hash !== '#dashboard') history.replaceState(null, '', '#dashboard');
  refresh();
  window.scrollTo(0, 0);
}
function closeDash(){
  document.documentElement.classList.remove('show-dashboard');
  document.title = siteTitle;
  // both views share one DOM here, so a deposit made in the dashboard would leave the
  // simulator showing a stale number — push the record back into it before handing over
  try {
    if(email && typeof window.loadUserData === 'function') window.loadUserData(email);
    if(typeof window.calculate === 'function') window.calculate();
  } catch(e){}
  window.scrollTo(0, 0);
}

document.querySelectorAll('a[href="#dashboard"]').forEach(a => {
  a.addEventListener('click', (e) => { e.preventDefault(); openDash(); });
});
document.querySelectorAll('#dashboardPage a[data-dash-exit]').forEach(a => {
  a.addEventListener('click', () => closeDash());
});
window.addEventListener('hashchange', () => {
  if(location.hash === '#dashboard') openDash();
  else if(document.documentElement.classList.contains('show-dashboard')) closeDash();
});

boot();
if((window.__ssHash0 || '') === '#dashboard') openDash();
""", 1, "js:boot hook")

# boot() must not render into a hidden layout — openDash() does that instead
js = rep(js, """  render();
  window.addEventListener('resize', () => drawChart(model()));""",
"""  window.addEventListener('resize', () => {
    if(document.documentElement.classList.contains('show-dashboard')) drawChart(model());
  });""", 1, "js:defer render")

# the quick-amount chips are rebuilt on every open, so the goal can change meanwhile
old_quick = """  // quick amounts scale with the goal, so they stay meaningful for a \u20aa50 goal and a \u20aa5,000 one
  const goalCost = Math.max(n('goalCost', 0), 1);
  const unit = goalCost >= 4000 ? 10 : (goalCost >= 800 ? 5 : 1);
  const steps = QUICK_STEPS.map(s => Math.max(Math.round((s * unit) / 5), 1));
  $('depQuick').innerHTML = steps.map(s => '<button type="button" data-add="' + s + '">+' + money(s) + '</button>').join('');
  $('depQuick').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('depInput');
      input.value = String((parseFloat(input.value) || 0) + parseFloat(btn.dataset.add));
      syncDepBtn();
      input.focus();
    });
  });
"""
new_quick = """  buildQuickAmounts();
"""
js = rep(js, old_quick, new_quick, 1, "js:quick amounts")

js = rep(js, "function syncDepBtn(){", """function buildQuickAmounts(){
  // quick amounts scale with the goal, so they stay meaningful for a \u20aa50 goal and a \u20aa5,000 one
  const goalCost = Math.max(n('goalCost', 0), 1);
  const unit = goalCost >= 4000 ? 10 : (goalCost >= 800 ? 5 : 1);
  const steps = QUICK_STEPS.map(s => Math.max(Math.round((s * unit) / 5), 1));
  $('depQuick').innerHTML = steps.map(s => '<button type="button" data-add="' + s + '">+' + money(s) + '</button>').join('');
  $('depQuick').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('depInput');
      input.value = String((parseFloat(input.value) || 0) + parseFloat(btn.dataset.add));
      syncDepBtn();
      input.focus();
    });
  });
}

function syncDepBtn(){""", 1, "js:buildQuickAmounts")

# the locked view must never be pre-hidden now that refresh() owns it
js = rep(js, """  if(!loadRecord() || record.goalCost === undefined){
    $('lockedView').hidden = false;
    cloudRescue();
    return;
  }

  $('dashView').hidden = false;
  $('userChip').hidden = false;
  $('userAvatar').textContent = (email.trim().charAt(0) || '?').toUpperCase();
  paintProviderBadge();
  $('userMail').textContent = email;
  $('greeting').textContent = t('dash.hello', { name: email.split('@')[0] });
  $('depCur').textContent = cur();
""", """  loadRecord();
""", 1, "js:boot gate")

js = "(function(){\n'use strict';\n" + js + "\n})();\n"

# ---------- assemble ----------
if fails:
    print("FAILED replacements:")
    for f in fails: print("  -", f)
    sys.exit(1)

out = index
out = out.replace("</head>", '<style id="dashboard-styles">\n' + css + "\n</style>\n</head>", 1)
out = out.replace('<link rel="icon"',
                  '<script>window.__ssSingleFile = true; window.__ssHash0 = location.hash;</script>\n<link rel="icon"', 1)
out = out.replace('href="dashboard.html"', 'href="#dashboard"')
out = out.replace("</body>", markup + "\n<script>\n" + js + "</script>\n</body>", 1)
# The PWA files are siblings on a server; a lone HTML file has no manifest, no
# icons and no sw.js next to it, so those tags would only produce 404s. The
# registration script already bails on __ssSingleFile — this drops the markup.
pwa_start = out.index('<!-- ===== ADD TO HOME SCREEN ===== -->')
pwa_end = out.index('</script>', out.index('serviceWorker', pwa_start)) + len('</script>')
out = out[:pwa_start] + '<!-- PWA tags removed: single file has no sibling manifest -->' + out[pwa_end:]

# The Supabase layer is a sibling file on a server and simply is not there next to
# a lone HTML file — inline it, or the whole cloud path is silently missing.
# Done after the PWA strip so neither edit can land inside the other's text.
supa_tag = '<script src="supabase/ss-supabase.js"></script>'
if out.count(supa_tag) != 1:
    print("FAILED: expected exactly 1 supabase script tag, found %d" % out.count(supa_tag))
    sys.exit(1)
if "</script>" in supa:
    print("FAILED: ss-supabase.js contains </script> and cannot be inlined as-is")
    sys.exit(1)
out = out.replace(supa_tag, "<script>\n" + supa + "</script>", 1)

# one file, no sibling favicon to point at
out = out.replace('<link rel="icon" href="favicon.svg" type="image/svg+xml">',
                  '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 64 64\'%3E%3Crect width=\'64\' height=\'64\' rx=\'16\' fill=\'%231F5EFF\'/%3E%3Cpath d=\'M14 42C24 42 26 20 34 20s10 10 16 0\' fill=\'none\' stroke=\'white\' stroke-width=\'5\' stroke-linecap=\'round\'/%3E%3Ccircle cx=\'50\' cy=\'20\' r=\'5\' fill=\'%23E4CD94\'/%3E%3C/svg%3E">', 1)

io.open(OUT, "w", encoding="utf-8", newline="").write(out)
print("wrote %s  (%.1f KB)" % (OUT, len(out.encode("utf-8")) / 1024.0))
print("dashboard.html links left:", out.count('href="dashboard.html"'))
print("favicon.svg refs left:", out.count("favicon.svg"))
print("external script refs left:", out.count("<script src="))
