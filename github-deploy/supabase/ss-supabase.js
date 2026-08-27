/* SmartSaver AI — שכבת Supabase (window.SSCloud)
 * ============================================================================
 *
 * כל התקשורת עם Supabase יושבת כאן, ורק כאן.
 *
 * למה fetch ידני ולא supabase-js מ-CDN:
 *   1. האתר הוא PWA שחייב לעבוד אופליין — תלות ב-CDN שוברת את זה.
 *   2. smartsaver-ai-complete.html הוא קובץ בודד; import חיצוני לא ישרוד את
 *      הבנייה, ו-<script type="module"> נחסם ב-file:// בגלל CORS.
 *   3. מה שצריך מ-Supabase כאן הוא ארבע קריאות REST. ספרייה שלמה בשביל זה
 *      היא הרבה משקל ואפס יתרון.
 *
 * העיקרון: localStorage נשאר המקור לאמת של המסך. Supabase הוא שכבה מעליו.
 * אם ה-url ריק, אם אין רשת, או אם השרת נופל — האתר מתנהג בדיוק כמו קודם.
 * שום פעולה של המשתמש לא נחסמת בגלל הענן.
 */
(function () {
'use strict';

var cfg  = window.SS_SUPABASE || {};
var BASE = typeof cfg.url === 'string' ? cfg.url.trim().replace(/\/+$/, '') : '';
var KEY  = typeof cfg.anonKey === 'string' ? cfg.anonKey.trim() : '';

/* Supabase מנפיק היום שני פורמטים של מפתח דפדפן: JWT ישן שמתחיל ב-eyJ,
   ומפתח חדש שמתחיל ב-sb_publishable_. שניהם תקינים כאן.
   הבדיקה קיימת בשביל שתי טעויות אמיתיות: הדבקת ה-Project ID במקום המפתח,
   שהייתה מתגלה רק כ-401 מאוחר יותר — ומפתח שרת בקוד של דפדפן, שהוא הרבה יותר
   גרוע: service_role עוקף את כל ה-RLS, וכל מי שפותח את הדף מקבל את הנתונים
   של כולם. עדיף לכבות את הענן בקול רם מלרוץ ככה. */
function keyIsBrowserSafe(k) {
  if (!k || k.length < 30) return false;

  if (k.indexOf('sb_secret_') === 0) {
    console.error('[SmartSaver] הודבק secret key. הענן כובה. השתמשו ב-Publishable key.');
    return false;
  }
  if (k.indexOf('sb_publishable_') === 0) return true;

  if (k.indexOf('eyJ') === 0) {
    var role = '';
    try {
      var p = k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      role = (JSON.parse(atob(p)) || {}).role || '';
    } catch (e) { return true; }   // לא הצלחנו לפענח — לא סיבה לחסום מפתח תקין
    if (role === 'service_role') {
      console.error('[SmartSaver] הודבק service_role key. הענן כובה. השתמשו ב-anon public.');
      return false;
    }
    return true;
  }

  console.error('[SmartSaver] SS_SUPABASE.anonKey לא נראה כמו מפתח Supabase. הענן כבוי.');
  return false;
}

var ON = BASE.indexOf('http') === 0 && keyIsBrowserSafe(KEY);

var SESSION_KEY = 'smartsaver_sb_session';
var QUEUE_KEY   = 'smartsaver_sb_queue';
var PENDING_KEY = 'smartsaver_sb_pending';
var TIMEOUT     = 12000;
var MAX_QUEUE   = 100;
var PUSH_DELAY  = 1500;

/* ---------- עזרי אחסון ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function jsonGet(k) { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } }

function userKey(email) { return 'smartsaver_user:' + String(email).toLowerCase(); }

/* ---------- שגיאות ---------- */
/* code אחיד שהאתר יכול להסתמך עליו, בלי קשר לגרסת GoTrue שרצה בפרויקט:
   גרסאות שונות מחזירות error_code, error, או רק msg בעברית של השרת. */
function CloudError(code, message, status) {
  var e = new Error(message || code);
  e.code = code;
  e.status = status || 0;
  return e;
}

function classify(status, body) {
  var raw = ((body && (body.error_code || body.code || body.error || body.msg || body.message)) || '') + '';
  var s = raw.toLowerCase();
  if (s.indexOf('already registered') !== -1 || s.indexOf('user_already_exists') !== -1) return 'user_exists';
  if (s.indexOf('invalid login') !== -1 || s.indexOf('invalid_grant') !== -1 ||
      s.indexOf('invalid_credentials') !== -1) return 'bad_credentials';
  if (s.indexOf('not confirmed') !== -1 || s.indexOf('email_not_confirmed') !== -1) return 'not_confirmed';
  if (s.indexOf('weak_password') !== -1 || s.indexOf('at least') !== -1 ||
      s.indexOf('password should be') !== -1) return 'weak_password';
  if (s.indexOf('rate') !== -1 || status === 429) return 'rate_limited';
  if (s.indexOf('validation_failed') !== -1 || s.indexOf('invalid format') !== -1) return 'bad_email';
  if (status === 401 || status === 403) return 'unauthorized';
  return 'server_error';
}

/* ---------- שכבת הרשת ---------- */
/* AbortController במקום להישען על timeout של הדפדפן: בלעדיו בקשה על רשת
   סלולרית גרועה תלויה דקות, והכפתור באתר נשאר disabled כל הזמן הזה. */
function request(path, opts) {
  opts = opts || {};
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || TIMEOUT) : 0;

  var headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];

  return fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    if (timer) clearTimeout(timer);
    return res.text().then(function (text) {
      var body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) { body = { msg: text }; } }
      if (!res.ok) throw CloudError(classify(res.status, body), (body && (body.msg || body.message || body.error_description)) || ('HTTP ' + res.status), res.status);
      return body;
    });
  }, function (err) {
    if (timer) clearTimeout(timer);
    /* abort ונפילת רשת נראים אותו דבר לקורא, ובשניהם התשובה זהה:
       לשמור בתור המקומי ולנסות שוב אחר כך. */
    throw CloudError('offline', (err && err.message) || 'network error', 0);
  });
}

/* ---------- סשן ---------- */
var session = jsonGet(SESSION_KEY);

function storeSession(s) {
  if (!s || !s.access_token) return null;
  session = {
    access_token:  s.access_token,
    refresh_token: s.refresh_token,
    /* expires_at מגיע בשניות ולפעמים לא מגיע בכלל — מנרמלים למילישניות */
    expires_at:    s.expires_at ? s.expires_at * 1000 : Date.now() + ((s.expires_in || 3600) * 1000),
    /* provider has to be carried across explicitly. Every token refresh calls
       this with a fresh user object that has no provider on it, and rebuilding
       the user from scratch silently dropped it — the Google mark vanished on
       the next refresh even though the account was still a Google account. */
    user: s.user
      ? {
          id:    s.user.id,
          email: s.user.email,
          provider: (s.user.app_metadata && s.user.app_metadata.provider) ||
                    (session && session.user && session.user.provider) || null
        }
      : (session && session.user) || null
  };
  lsSet(SESSION_KEY, JSON.stringify(session));
  return session;
}

function clearSession() { session = null; lsDel(SESSION_KEY); }

/* מרעננים 60 שניות לפני הפקיעה, לא אחריה — אחרת כל בקשה ראשונה אחרי שעה
   נכשלת פעם אחת ומחזירה 401 למשתמש בלי סיבה. */
var refreshing = null;
function token() {
  if (!session || !session.access_token) return Promise.resolve(null);
  if (Date.now() < session.expires_at - 60000) return Promise.resolve(session.access_token);
  if (!session.refresh_token) return Promise.resolve(session.access_token);
  if (refreshing) return refreshing;

  refreshing = request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: session.refresh_token }
  }).then(function (data) {
    refreshing = null;
    return storeSession(data) ? session.access_token : null;
  }, function (err) {
    refreshing = null;
    /* refresh token שנדחה הוא סשן מת — מנקים כדי שהאתר יחזור למצב מנותק
       במקום לנסות שוב ושוב. נפילת רשת דווקא לא מוחקת כלום. */
    if (err.code !== 'offline') clearSession();
    return null;
  });
  return refreshing;
}

/* ---------- אימות ---------- */

/* מחזיר 'session' אם המשתמש מחובר עכשיו, או 'confirm' אם Supabase מחכה
   לאישור במייל (ההגדרה Confirm email דלוקה — ראו README). */
function signUp(email, password) {
  return request('/auth/v1/signup', {
    method: 'POST',
    body: { email: email, password: password }
  }).then(function (data) {
    /* GoTrue עם הגנת enumeration מחזיר 200 ומשתמש מזויף בלי identities
       כשהאימייל כבר תפוס — בלי הבדיקה הזו היינו מציגים "בדוק את המייל"
       למישהו שפשוט הקליד סיסמה שגויה. */
    if (data && data.identities && data.identities.length === 0) throw CloudError('user_exists', 'already registered', 400);
    if (data && data.access_token) { storeSession(data); return 'session'; }
    if (data && data.session && data.session.access_token) { storeSession(data.session); return 'session'; }
    return 'confirm';
  });
}

function signIn(email, password) {
  return request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: email, password: password }
  }).then(function (data) {
    if (!storeSession(data)) throw CloudError('server_error', 'no session in response', 0);
    return 'session';
  });
}

/* הזרימה שהטופס באתר מצפה לה: אימייל + סיסמה אחד, בלי מסך "הרשמה" נפרד.
   מנסים להתחבר; אם אין חשבון — נרשמים. GoTrue לא מבדיל בין "אין משתמש"
   ל"סיסמה שגויה" (וטוב שכך), ולכן ההרשמה היא זו שמכריעה: אם היא אומרת
   שהמשתמש קיים, אז מה שקרה קודם היה סיסמה שגויה. */
function signInOrUp(email, password) {
  return signIn(email, password).then(function () {
    return 'ok';
  }, function (err) {
    if (err.code !== 'bad_credentials') throw err;
    return signUp(email, password).then(function (result) {
      return result === 'confirm' ? 'confirm' : 'created';
    }, function (err2) {
      throw err2.code === 'user_exists' ? CloudError('bad_credentials', 'wrong password', 400) : err2;
    });
  });
}

function signOut() {
  var t = session && session.access_token;
  clearSession();
  lsDel(PENDING_KEY);
  if (!t) return Promise.resolve();
  /* הסשן המקומי כבר נמחק, אז גם אם הקריאה נכשלת המשתמש מנותק כאן */
  return request('/auth/v1/logout', { method: 'POST', token: t }).catch(function () {});
}

function resetPassword(email, redirectTo) {
  return request('/auth/v1/recover', {
    method: 'POST',
    body: redirectTo ? { email: email, redirect_to: redirectTo } : { email: email }
  });
}

function user() { return (session && session.user) || null; }

/* ---------- הרשומה: מה עולה לענן ומה לא ---------- */

/* pwHash ו-pwSalt הם מנגנון ההתחברות המקומי שרץ כשאין רשת. אין שום סיבה
   שהם יעלו לשרת — Supabase מנהל את הסיסמאות בעצמו, וגיבוב שנשלח לרשת הוא
   סיכון בלי תמורה. הם נשארים על המכשיר, וכל pull משמר את המקומיים. */
function isPrivate(k) { return k.indexOf('pw') === 0; }

function publicPart(record) {
  var out = {};
  for (var k in record) if (Object.prototype.hasOwnProperty.call(record, k) && !isPrivate(k)) out[k] = record[k];
  return out;
}

/* מיזוג בין מכשירים.
   הרשומה החדשה יותר מנצחת בשדות הרגילים — אבל לא בהפקדות. הפקדה שנרשמה
   בטלפון בזמן שהמחשב היה פתוח על נתון ישן הייתה נמחקת ב"החדש מנצח" נאיבי,
   וזה בדיוק הנתון שאסור לאבד. לכן ההפקדות מאוחדות לפי ts, ולכל הפקדה
   שנוספה מהצד המפסיד גם הסכום שלה מתווסף ל-alreadySaved, כדי שהמספר
   על המסך ימשיך להיות סכום ההפקדות ועוד הסכום ההתחלתי. */
function mergeRecords(local, cloud) {
  local = local || {};
  cloud = cloud || {};
  var localNewer = (local.savedAt || 0) >= (cloud.savedAt || 0);
  var winner = localNewer ? local : cloud;
  var loser  = localNewer ? cloud : local;

  var merged = {};
  for (var k in winner) if (Object.prototype.hasOwnProperty.call(winner, k)) merged[k] = winner[k];

  var wDeps = Array.isArray(winner.deposits) ? winner.deposits : [];
  var lDeps = Array.isArray(loser.deposits) ? loser.deposits : [];
  if (lDeps.length) {
    var seen = {};
    wDeps.forEach(function (d) { seen[d.ts] = true; });
    var added = lDeps.filter(function (d) { return d && !seen[d.ts]; });
    if (added.length) {
      merged.deposits = wDeps.concat(added).sort(function (a, b) { return a.ts - b.ts; });
      var extra = added.reduce(function (sum, d) { return sum + (parseFloat(d.amount) || 0); }, 0);
      merged.alreadySaved = String((parseFloat(merged.alreadySaved) || 0) + extra);
    }
  }
  return merged;
}

/* ---------- pull ---------- */

/* מושך את הרשומה מהענן, ממזג עם המקומית וכותב את התוצאה ל-localStorage.
   מחזיר true אם משהו השתנה — האתר קורא ל-loadUserData() רק אז. */
function syncDown(email) {
  if (!ON) return Promise.resolve(false);
  var u = user();
  if (!u) return Promise.resolve(false);

  return token().then(function (t) {
    if (!t) return false;
    return request('/rest/v1/profiles?select=data,saved_at&id=eq.' + u.id, { token: t }).then(function (rows) {
      var cloud = (rows && rows[0]) || null;
      var localRaw = jsonGet(userKey(email)) || {};

      if (!cloud || !cloud.data || !Object.keys(cloud.data).length) {
        /* אין עדיין כלום בענן — המכשיר הזה הוא המקור */
        return syncUp(email, localRaw).then(function () { return false; });
      }

      var cloudRec = cloud.data;
      cloudRec.savedAt = cloud.saved_at || cloudRec.savedAt || 0;
      var merged = mergeRecords(localRaw, cloudRec);

      /* הסודות המקומיים לא מגיעים מהענן, אז מחזירים אותם לרשומה הממוזגת */
      for (var k in localRaw) if (isPrivate(k)) merged[k] = localRaw[k];

      var before = JSON.stringify(localRaw);
      var after  = JSON.stringify(merged);
      if (before === after) return false;

      lsSet(userKey(email), after);
      /* המיזוג ייצר מצב שלישי שלא קיים בשום צד — צריך לחזור גם לענן */
      syncUp(email, merged);
      return true;
    });
  }).catch(function () { return false; });
}

/* ---------- push ---------- */

function syncUp(email, record) {
  if (!ON) return Promise.resolve(false);
  var u = user();
  if (!u) return Promise.resolve(false);

  var payload = publicPart(record || {});
  return token().then(function (t) {
    if (!t) throw CloudError('unauthorized', 'no token', 401);
    return request('/rest/v1/profiles', {
      method: 'POST',
      token: t,
      /* upsert: הפרופיל נוצר בטריגר בהרשמה, אבל אם מישהו מחק אותו ידנית
         או שהטריגר לא הותקן, השורה עדיין נוצרת כאן במקום להיכשל ב-409. */
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [{
        id: u.id,
        email: email || u.email || null,
        data: payload,
        saved_at: record && record.savedAt ? record.savedAt : Date.now()
      }]
    });
  }).then(function () {
    lsDel(PENDING_KEY);
    return true;
  }, function () {
    /* נכשל — שומרים את הרשומה לניסיון הבא. רשומה אחת, לא תור:
       השמירה האחרונה ממילא מכילה את כל מה שקדם לה. */
    lsSet(PENDING_KEY, JSON.stringify({ email: email, record: record }));
    return false;
  });
}

/* השמירה באתר רצה על כל הקלדה. בלי ההשהיה הזו כל תו בשם היעד היה בקשת
   רשת נפרדת. 1.5 שניות אחרי שהמשתמש מפסיק להקליד זה עדיין "מיידי" בעיניו. */
var pushTimer = 0, pushPending = null;
function syncUpSoon(email, record) {
  if (!ON || !user()) return;
  pushPending = { email: email, record: record };
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function () {
    var p = pushPending;
    pushPending = null;
    if (p) syncUp(p.email, p.record);
  }, PUSH_DELAY);
}

/* מוציא מיד מה שממתין — לפני התנתקות או סגירת הלשונית */
function flushPush() {
  clearTimeout(pushTimer);
  var p = pushPending;
  pushPending = null;
  if (p) return syncUp(p.email, p.record);
  return Promise.resolve(false);
}

/* ---------- יומן הפעולות ---------- */

function readQueue() { var q = jsonGet(QUEUE_KEY); return Array.isArray(q) ? q : []; }
function writeQueue(q) { lsSet(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); }

function postEvents(rows) {
  return token().then(function (t) {
    if (!t) throw CloudError('unauthorized', 'no token', 401);
    return request('/rest/v1/events', {
      method: 'POST',
      token: t,
      headers: { Prefer: 'return=minimal' },
      body: rows
    });
  });
}

function logEvent(event, extra) {
  if (!ON) return;
  var u = user();
  if (!u) return;
  extra = extra || {};
  var row = {
    user_id:   u.id,
    ts:        new Date().toISOString(),
    event:     event,
    email:     extra.email || u.email || null,
    goal_name: extra.goalName || null,
    goal_cost: numOrNull(extra.goalCost),
    saved:     numOrNull(extra.saved),
    amount:    numOrNull(extra.amount),
    pct:       numOrNull(extra.pct),
    device:    window.matchMedia('(max-width: 760px)').matches ? 'mobile' : 'desktop'
  };
  /* הפקדה שאבדה גרועה מהפקדה שנרשמה באיחור — כישלון נכנס לתור ולא נעלם */
  postEvents([row]).catch(function () { var q = readQueue(); q.push(row); writeQueue(q); });
}

function numOrNull(v) {
  var f = parseFloat(v);
  return isFinite(f) ? f : null;
}

function flushEvents() {
  if (!ON || !user()) return Promise.resolve();
  var q = readQueue();
  if (!q.length) return Promise.resolve();
  writeQueue([]);
  /* בקשה אחת לכל התור: PostgREST מקבל מערך שורות ב-insert אחד */
  return postEvents(q).catch(function () {
    var rest = readQueue();
    writeQueue(q.concat(rest));
  });
}

/* ---------- שחזור אחרי ניתוק ---------- */

function flush() {
  if (!ON || !user()) return Promise.resolve();
  var pending = jsonGet(PENDING_KEY);
  if (pending && pending.email) syncUp(pending.email, pending.record);
  return flushEvents();
}

window.addEventListener('online', flush);
window.addEventListener('load', function () { setTimeout(flush, 1200); });

/* סגירת לשונית באמצע ההשהיה של 1.5 שניות הייתה מאבדת את השמירה האחרונה.
   visibilitychange הוא האירוע היחיד שאפשר לסמוך עליו בנייד — pagehide
   ו-beforeunload פשוט לא נורים שם כשעוברים אפליקציה. */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushPush();
});

/* ---------- ה-API הציבורי ---------- */
/* ---------- OAuth (המשך עם גוגל) ----------

   בלי ה-SDK אין PKCE, אז משתמשים ב-implicit flow: Supabase מחזיר את הטוקנים
   ב-hash של הכתובת. זה עובד מול דפדפן, וזה מה שיש כשטוענים סקריפט אחד בלי בנייה.

   הכתובת שחוזרים אליה חייבת להופיע ב-Supabase תחת
   Authentication → URL Configuration → Redirect URLs, אחרת גוגל יאשר
   והחזרה תיחסם. */
function oauthUrl(provider, redirectTo) {
  return cfg.url + '/auth/v1/authorize'
       + '?provider=' + encodeURIComponent(provider)
       + '&redirect_to=' + encodeURIComponent(redirectTo || location.href.split('#')[0])
       /* Google skips both the picker and the consent screen once an account is
          signed in and has approved before. On a family computer that silently
          signs the child in as whoever was left logged in, and never shows what
          is being shared. Both screens are asked for every time, on purpose. */
       + '&prompt=' + encodeURIComponent('select_account consent');
}

function signInWithProvider(provider, redirectTo) {
  if (!ON) return false;
  location.href = oauthUrl(provider, redirectTo);
  return true;
}

/* נקרא פעם אחת בטעינה. אם חזרנו מגוגל — שומר את הסשן ומנקה את ה-hash,
   כדי שרענון לא ינסה לצרוך טוקן שכבר נצרך ושהטוקן לא יישאר בהיסטוריה. */
function consumeOAuthRedirect() {
  if (!ON) return null;
  var h = location.hash || '';
  if (h.indexOf('access_token=') === -1) {
    /* גוגל מחזיר שגיאות כפרמטרים, לא כחריגה — בלי זה כישלון נראה כמו כלום */
    if (h.indexOf('error=') !== -1) {
      var e = new URLSearchParams(h.slice(1));
      history.replaceState(null, '', location.pathname + location.search);
      return { error: e.get('error_description') || e.get('error') };
    }
    return null;
  }

  var p = new URLSearchParams(h.slice(1));
  var s = storeSession({
    access_token:  p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_in:    parseInt(p.get('expires_in'), 10) || 3600
  });
  history.replaceState(null, '', location.pathname + location.search);
  if (!s) return { error: 'no token' };

  /* ה-hash לא כולל את פרטי המשתמש — שולפים אותם כדי שיהיה אימייל להציג */
  return request('/auth/v1/user', { token: s.access_token }).then(function (u) {
    if (u && u.id) {
      session.user = {
        id: u.id,
        email: u.email,
        /* which provider this session came from, so the UI can show it */
        provider: (u.app_metadata && u.app_metadata.provider) || 'google'
      };
      lsSet(SESSION_KEY, JSON.stringify(session));
    }
    return { user: session.user };
  }, function () { return { user: session.user }; });
}

window.SSCloud = {
  configured:    function () { return ON; },
  signedIn:      function () { return !!(ON && user()); },
  user:          user,
  signIn:        signIn,
  signUp:        signUp,
  signInOrUp:    signInOrUp,
  signOut:       signOut,
  resetPassword: resetPassword,
  signInWithProvider: signInWithProvider,
  consumeOAuthRedirect: consumeOAuthRedirect,
  syncDown:      syncDown,
  syncUp:        syncUp,
  syncUpSoon:    syncUpSoon,
  flushPush:     flushPush,
  logEvent:      logEvent,
  flush:         flush,
  mergeRecords:  mergeRecords
};

})();
