/* Two languages, one table.

   The panel was written in Persian, which makes it unusable for most of the
   people who might install it from a public repository - and English alone
   would have been no better for the person it was built for. So every string
   lives here rather than in the markup, and the choice is the reader's.

   Direction changes with the language: Persian is right to left, English is
   not, and a layout that only ever gets one of those tested is a layout that
   breaks the first time someone switches. */

const STRINGS = {
  fa: {
    dir: 'rtl', lang: 'fa', label: 'فارسی',
    add_server: 'افزودن سرور', groups: 'گروه‌ها', logout: 'خروج',
    empty: 'هنوز سروری اضافه نشده. با دکمهٔ «افزودن سرور» شروع کن.',
    online: 'آنلاین', offline: 'آفلاین',
    cpu: 'پردازنده', memory: 'حافظه', disk: 'دیسک',
    today: 'امروز', week: '۷ روز', month: '۳۰ روز',
    bandwidth: 'پهنای باند', of_online: '%s از %s آنلاین', n_servers: '%s سرور',
    ungrouped: 'بدون گروه',
    // detail
    status: 'وضعیت', load: 'بار سیستم', uptime: 'روشن بوده',
    traffic_today: 'ترافیک امروز', traffic_month: 'ترافیک ۳۰ روز',
    cpu_mem: 'پردازنده و حافظه (٪)', disk_use: 'مصرف دیسک (٪)',
    bw_bits: 'پهنای باند (بیت بر ثانیه)',
    avg_daily: ' — میانگین روزانه', avg_hourly: ' — میانگین ساعتی',
    download: 'دریافت', upload: 'ارسال',
    thin: 'هنوز داده‌ی کافی جمع نشده — هر دقیقه یک نمونه گرفته می‌شود، پس نمودارها در ساعت اول کم‌جان‌اند.',
    close: 'بستن', days: 'روز', hours: 'ساعت',
    // form
    add_title: 'افزودن سرور', edit_title: 'ویرایش سرور',
    f_name: 'نام', f_name_ph: 'مثلاً سرور آلمان',
    f_host: 'آدرس یا آی‌پی', f_port: 'پورت', f_user: 'نام کاربری', f_group: 'گروه',
    auth_password: 'رمز عبور', auth_key: 'کلید خصوصی SSH',
    f_key: 'کلید خصوصی', f_passphrase: 'عبارت عبور کلید',
    f_passphrase_hint: '(اگر کلید رمز دارد)',
    test: 'تست اتصال', save: 'ذخیره', del: 'حذف',
    testing: 'در حال تست…', connected: 'وصل شد',
    cores: 'هسته', ram: 'رم',
    e_need: '%s لازم است', e_save: 'ذخیره نشد', e_conn: 'اتصال ناموفق',
    confirm_del: '«%s» حذف شود؟ تاریخچه‌اش هم پاک می‌شود.',
    confirm_twin: '«%s» همین حالا همین آدرس را دارد. باز هم اضافه شود؟',
    // groups
    g_title: 'گروه‌ها',
    g_sub: 'گروه بساز و بعد کارت سرورها را با کشیدن داخلشان بگذار.',
    g_new: 'نام گروه تازه', g_new_ph: 'مثلاً سرورهای کردیتی', g_make: 'بساز',
    g_none: 'هنوز گروهی نساخته‌ای.', g_name: 'نام گروه',
    g_del: 'حذف گروه', g_edit: 'ویرایش و حذف',
    g_confirm_del: 'گروه «%s» حذف شود؟ سرورهایش پاک نمی‌شوند، فقط بی‌گروه می‌شوند.',
    g_need_name: 'نام گروه لازم است', g_failed: 'ساخته نشد',
    g_rename_failed: 'تغییر نام نشد',
    layout_failed: 'چیدمان ذخیره نشد: %s', unknown: 'خطای ناشناخته',
    boot_failed: 'پنل بالا نیامد — %s. صفحه را با Ctrl+Shift+R تازه کن؛ اگر باز هم بود، خطا در کنسول مرورگر است.',
    boot_script: 'خطا در اسکریپت', boot_norun: 'اسکریپت اجرا نشد',
    pct: '٪',
  },
  en: {
    dir: 'ltr', lang: 'en', label: 'English',
    add_server: 'Add server', groups: 'Groups', logout: 'Sign out',
    empty: 'No servers yet. Start with the “Add server” button.',
    online: 'online', offline: 'offline',
    cpu: 'CPU', memory: 'Memory', disk: 'Disk',
    today: 'Today', week: '7 days', month: '30 days',
    bandwidth: 'Bandwidth', of_online: '%s of %s online', n_servers: '%s servers',
    ungrouped: 'Ungrouped',
    status: 'Status', load: 'Load', uptime: 'Uptime',
    traffic_today: 'Traffic today', traffic_month: 'Traffic, 30 days',
    cpu_mem: 'CPU and memory (%)', disk_use: 'Disk usage (%)',
    bw_bits: 'Bandwidth (bits per second)',
    avg_daily: ' — daily average', avg_hourly: ' — hourly average',
    download: 'Down', upload: 'Up',
    thin: 'Not enough history yet — one sample a minute, so the charts are thin for the first hour.',
    close: 'Close', days: 'd', hours: 'h',
    add_title: 'Add server', edit_title: 'Edit server',
    f_name: 'Name', f_name_ph: 'e.g. Germany box',
    f_host: 'Host or IP', f_port: 'Port', f_user: 'Username', f_group: 'Group',
    auth_password: 'Password', auth_key: 'SSH private key',
    f_key: 'Private key', f_passphrase: 'Key passphrase',
    f_passphrase_hint: '(if the key has one)',
    test: 'Test connection', save: 'Save', del: 'Delete',
    testing: 'Testing…', connected: 'Connected',
    cores: 'cores', ram: 'RAM',
    e_need: '%s is required', e_save: 'Could not save', e_conn: 'Could not connect',
    confirm_del: 'Delete “%s”? Its history goes too.',
    confirm_twin: '“%s” already has this address. Add it anyway?',
    g_title: 'Groups',
    g_sub: 'Make a group, then drag server cards into it.',
    g_new: 'New group name', g_new_ph: 'e.g. Credit-billed', g_make: 'Create',
    g_none: 'No groups yet.', g_name: 'Group name',
    g_del: 'Delete group', g_edit: 'Edit and delete',
    g_confirm_del: 'Delete the group “%s”? Its servers stay — they just become ungrouped.',
    g_need_name: 'A group name is required', g_failed: 'Could not create',
    g_rename_failed: 'Could not rename',
    layout_failed: 'Could not save the arrangement: %s', unknown: 'unknown error',
    boot_failed: 'The panel did not start — %s. Reload with Ctrl+Shift+R; if it persists, the error is in the browser console.',
    boot_script: 'a script error', boot_norun: 'the script did not run',
    pct: '%',
  },
};

const LANG_KEY = 'hostpulse.lang';

function currentLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && STRINGS[saved]) return saved;
  } catch (e) { /* private mode */ }
  // Follow the browser once, then never guess again.
  return (navigator.language || '').startsWith('fa') ? 'fa' : 'en';
}

let LANG = currentLang();
let T = STRINGS[LANG];

/** Look up a string, filling %s placeholders in order. */
function t(key, ...args) {
  let s = T[key] !== undefined ? T[key] : key;
  for (const a of args) s = s.replace('%s', a);
  return s;
}

function setLang(code) {
  if (!STRINGS[code]) return;
  LANG = code;
  T = STRINGS[code];
  try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
  applyLang();
}

/** Direction, language attribute, and every string marked in the markup. */
function applyLang() {
  const html = document.documentElement;
  html.lang = T.lang;
  html.dir = T.dir;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  const btn = document.getElementById('lang-btn');
  // The button offers the other language, not the one already in use.
  if (btn) btn.textContent = STRINGS[LANG === 'fa' ? 'en' : 'fa'].label;
}
