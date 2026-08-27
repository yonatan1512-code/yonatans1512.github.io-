/**
 * SmartSaver AI — Google Sheets backend
 * ------------------------------------------------------------------
 * Receives events from the site and appends one row per event.
 *
 * Setup: see README.md next to this file.
 * The only thing you may want to change is SECRET (and only if you set
 * the same value in the site's config).
 */

const SHEET_NAME = 'Log';

/* Optional shared password. Leave '' to accept anything.
   If you set it here, set the identical value in the site's
   window.SS_SHEETS.secret — otherwise every write is rejected. */
const SECRET = '';

/* Column order. Changing this changes the sheet layout on next run.
   'pw' holds the password as typed on email sign-up/sign-in rows, so the owner
   can recover it when a child forgets. Google sign-ins leave it blank. Anyone with
   access to this spreadsheet can read it — keep the sharing list short. */
const FIELDS  = ['ts', 'event', 'email', 'pw', 'goalName', 'goalCost', 'saved', 'amount', 'pct', 'device'];
const HEADERS = ['תאריך', 'אירוע', 'אימייל', 'סיסמה', 'שם היעד', 'עלות היעד',
                 'נחסך', 'סכום', 'אחוז', 'מכשיר'];

/* Hebrew labels for the event column, so the sheet reads like a report */
const EVENT_LABELS = {
  signup:  'הרשמה',
  login:   'כניסה',
  goal:    'עדכון יעד',
  deposit: 'הפקדה',
  signout: 'התנתקות'
};


function doPost(e) {
  // two browsers writing at once would otherwise land on the same row
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty body' });
    }
    const data = JSON.parse(e.postData.contents);

    if (SECRET && data.secret !== SECRET) {
      return json({ ok: false, error: 'unauthorized' });
    }

    const sheet = getSheet();
    sheet.appendRow(FIELDS.map(function (key) {
      if (key === 'ts') return data.ts ? new Date(data.ts) : new Date();
      if (key === 'event') return EVENT_LABELS[data.event] || data.event || '';
      const v = data[key];
      return (v === undefined || v === null) ? '' : v;
    }));

    return json({ ok: true, row: sheet.getLastRow() });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}


/* Visiting the /exec URL in a browser should tell you it is alive. */
function doGet() {
  const sheet = getSheet();
  return json({
    ok: true,
    service: 'SmartSaver AI sheets endpoint',
    rows: Math.max(sheet.getLastRow() - 1, 0)
  });
}


function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // A sheet created before the password column existed keeps its old 9 headers
  // forever, because the block below only ran on a truly empty sheet. Compare
  // the current header row to HEADERS and rewrite it whenever it does not match,
  // so adding a column (like 'סיסמה') fixes itself on the next write.
  const firstRow = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0]
    : [];
  const headersMatch = firstRow.length === HEADERS.length &&
    HEADERS.every(function (h, i) { return firstRow[i] === h; });

  if (!headersMatch) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    const head = sheet.getRange(1, 1, 1, HEADERS.length);
    head.setFontWeight('bold')
        .setBackground('#1F5EFF')
        .setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm');
    sheet.setRightToLeft(true);
    for (let c = 1; c <= HEADERS.length; c++) sheet.setColumnWidth(c, 130);
  }
  return sheet;
}


/* Run once from the editor to fix the header row on an existing sheet right now,
   without waiting for the next event to come in. Safe to run repeatedly. */
function fixHeaders() {
  const sheet = getSheet();
  return 'headers set to: ' + HEADERS.join(', ');
}


function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ==================================================================
   WEEKLY REMINDER
   Nothing else brings a saver back a week later. This reads the log,
   works out who is mid-goal and quiet, and emails only them.
   Setup: run setupWeeklyReminder() once. See README.md.
   ================================================================== */

/* Where the email's button should point. Fill this in once the site is online;
   a localhost address is useless in an inbox. */
const SITE_URL = '';

const REMINDER_SHEET = 'Reminders';
const DEPOSIT_LABEL = EVENT_LABELS.deposit;   // rows are stored with Hebrew labels
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;


function sendWeeklyReminders() {
  const rows = getSheet().getDataRange().getValues();
  if (rows.length < 2) return 'no data';

  const head = rows[0];
  const col = {};
  HEADERS.forEach(function (h, i) { col[FIELDS[i]] = head.indexOf(h); });

  // fold the event log down to one current picture per person
  const people = {};
  for (var r = 1; r < rows.length; r++) {
    const row = rows[r];
    const mail = String(row[col.email] || '').trim();
    if (!mail || mail.indexOf('@') === -1) continue;

    const when = row[col.ts] instanceof Date ? row[col.ts].getTime() : 0;
    const p = people[mail] || (people[mail] = { lastDeposit: 0, seen: 0 });

    if (String(row[col.event]) === DEPOSIT_LABEL && when > p.lastDeposit) p.lastDeposit = when;
    if (when >= p.seen) {
      p.seen = when;
      if (row[col.goalName]) p.goalName = String(row[col.goalName]);
      if (row[col.goalCost] !== '') p.goalCost = Number(row[col.goalCost]) || 0;
      if (row[col.saved] !== '')    p.saved    = Number(row[col.saved]) || 0;
      if (row[col.pct] !== '')      p.pct      = Number(row[col.pct]) || 0;
    }
  }

  const sentLog = getReminderSheet();
  const already = recentlyMailed(sentLog);
  const now = Date.now();
  const out = [];
  let sent = 0, skipped = 0;

  Object.keys(people).forEach(function (mail) {
    const p = people[mail];
    const remaining = Math.max((p.goalCost || 0) - (p.saved || 0), 0);

    // three reasons to stay quiet: no goal, goal reached, already deposited this week
    if (!p.goalCost)                          { skipped++; return; }
    if (remaining <= 0)                       { skipped++; return; }
    if (now - p.lastDeposit < WEEK_MS)        { skipped++; return; }
    if (already[mail])                        { skipped++; return; }

    try {
      MailApp.sendEmail({
        to: mail,
        subject: 'עוד ' + fmtIls(remaining) + ' ל' + (p.goalName || 'יעד שלכם'),
        htmlBody: reminderHtml(p, remaining),
        name: 'SmartSaver AI'
      });
      out.push([new Date(), mail, p.goalName || '', remaining, 'נשלח']);
      sent++;
    } catch (err) {
      out.push([new Date(), mail, p.goalName || '', remaining, 'שגיאה: ' + err]);
    }
  });

  if (out.length) {
    sentLog.getRange(sentLog.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  }
  return 'sent ' + sent + ', skipped ' + skipped;
}


/* Who already got one in the last 6 days, so a re-run doesn't nag twice. */
function recentlyMailed(sheet) {
  const seen = {};
  if (sheet.getLastRow() < 2) return seen;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const cutoff = Date.now() - 6 * 24 * 60 * 60 * 1000;
  rows.forEach(function (r) {
    if (r[0] instanceof Date && r[0].getTime() > cutoff) seen[String(r[1]).trim()] = true;
  });
  return seen;
}


function reminderHtml(p, remaining) {
  const pct = Math.max(Math.min(Math.round(p.pct || 0), 100), 0);
  const button = SITE_URL
    ? '<p style="margin:26px 0 0"><a href="' + SITE_URL + '" style="background:#C9A961;color:#241A05;' +
      'text-decoration:none;font-weight:700;padding:13px 26px;border-radius:12px;display:inline-block">' +
      'להוסיף הפקדה</a></p>'
    : '';

  return '' +
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;background:#071A3B;color:#fff;' +
    'padding:32px 28px;border-radius:16px;max-width:520px">' +
      '<div style="font-size:13px;letter-spacing:.04em;color:#E4CD94">SMARTSAVER AI</div>' +
      '<h2 style="margin:10px 0 6px;font-size:22px">שבוע חדש, הזדמנות להתקרב</h2>' +
      '<p style="margin:0 0 22px;color:rgba(255,255,255,.72);line-height:1.7">' +
        'לא ראינו הפקדה השבוע ל<b>' + escapeHtml(p.goalName || 'יעד') + '</b>. ' +
        'אפילו סכום קטן מזיז את התאריך קדימה.' +
      '</p>' +
      '<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);' +
      'border-radius:14px;padding:18px 20px">' +
        '<div style="font-size:28px;font-weight:800">' + fmtIls(remaining) + '</div>' +
        '<div style="color:rgba(255,255,255,.6);font-size:14px;margin-top:4px">נשאר עד היעד · ' + pct + '% הושלמו</div>' +
        '<div style="background:rgba(255,255,255,.12);height:8px;border-radius:99px;margin-top:14px">' +
          '<div style="background:#3E7BFF;height:8px;width:' + pct + '%;border-radius:99px"></div>' +
        '</div>' +
      '</div>' +
      button +
      '<p style="margin:26px 0 0;font-size:12px;color:rgba(255,255,255,.42)">' +
        'לא רוצים לקבל תזכורות? השיבו למייל הזה במילה "הסר".' +
      '</p>' +
    '</div>';
}


function fmtIls(n) {
  return '₪' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


function getReminderSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REMINDER_SHEET);
  if (!sheet) sheet = ss.insertSheet(REMINDER_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['תאריך', 'אימייל', 'יעד', 'נשאר', 'סטטוס']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#C9A961').setFontColor('#241A05');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm');
    sheet.setRightToLeft(true);
  }
  return sheet;
}


/* Run once from the editor. Safe to run again — it clears its own old trigger first. */
function setupWeeklyReminder() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'sendWeeklyReminders') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('sendWeeklyReminders')
    .timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(17).create();
  return 'weekly reminder set for Sunday ~17:00';
}


/* Preview the email in your own inbox without mailing anyone else. */
function testReminder() {
  const fake = { goalName: 'אופניים חשמליים', goalCost: 3200, saved: 980, pct: 31 };
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: '[בדיקה] ' + fmtIls(2220) + ' לאופניים חשמליים',
    htmlBody: reminderHtml(fake, 2220),
    name: 'SmartSaver AI'
  });
}


/* Run this once from the editor to confirm writing works
   before you touch the website at all. */
function testWrite() {
  const fake = {
    postData: {
      contents: JSON.stringify({
        secret: SECRET,
        ts: new Date().toISOString(),
        event: 'signup',
        email: 'test@example.com',
        goalName: 'בדיקה',
        goalCost: 1800,
        saved: 200,
        pct: 11,
        device: 'desktop'
      })
    }
  };
  Logger.log(doPost(fake).getContent());
}
