/* Общие помощники клиентской части и админ-панели: Telegram WebApp, API, DOM, форматирование. */
(function () {
  'use strict';

  const tg = (window.Telegram && window.Telegram.WebApp) || null;
  // Вне Telegram initData пустая — тогда показываем свои кнопки вместо нативных
  const inTelegram = Boolean(tg && tg.initData);

  function versionAtLeast(version) {
    return Boolean(inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast(version));
  }

  function safely(fn) {
    try {
      fn();
    } catch (e) {
      /* метод не поддерживается этой версией Telegram */
    }
  }

  // ---------- DOM ----------

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    const { value, ...rest } = attrs || {};
    for (const [key, val] of Object.entries(rest)) {
      if (val == null || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
      else if (typeof val === 'boolean') el[key] = val;
      else el.setAttribute(key, val);
    }
    append(el, children);
    // value — после детей, иначе <select> не найдёт нужный <option>
    if (value != null) el.value = value;
    return el;
  }

  function cls(...names) {
    return names.filter(Boolean).join(' ');
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (inTelegram) headers.Authorization = 'tma ' + tg.initData;
    const init = { method: options.method || 'GET', headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (e) {
      throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз', 0);
    }
    if (response.status === 204) return null;
    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      /* пустой ответ */
    }
    if (!response.ok) {
      const detail = data && typeof data.detail === 'string' ? data.detail : `Ошибка сервера (${response.status})`;
      throw new ApiError(detail, response.status);
    }
    return data;
  }

  // ---------- нативные элементы Telegram с запасным вариантом для браузера ----------

  const mainButton = (() => {
    let handler = null;
    let enabled = true;
    let bar = null;
    let button = null;

    function onClick() {
      if (enabled && handler) handler();
    }

    function ensureFallback() {
      if (bar) return;
      button = h('button', { class: 'btn', type: 'button', onClick });
      bar = h('div', { class: 'fallback-bar', hidden: true }, button);
      document.body.appendChild(bar);
    }

    function paint(text) {
      if (inTelegram) {
        // Telegram для Android не обновляет текст уже показанной кнопки (оставалось «Сохранить график»
        // на вкладке «Услуги»), поэтому при смене текста кнопку сначала прячем
        if (text !== undefined && tg.MainButton.isVisible && tg.MainButton.text !== text) tg.MainButton.hide();
        const theme = tg.themeParams || {};
        const params = {
          is_visible: true,
          is_active: enabled,
          color: enabled ? theme.button_color || '#2481cc' : theme.hint_color || '#a0a0a0',
          text_color: theme.button_text_color || '#ffffff',
        };
        if (text !== undefined) params.text = text;
        tg.MainButton.setParams(params);
      } else {
        ensureFallback();
        if (text !== undefined) button.textContent = text;
        button.disabled = !enabled;
        bar.hidden = false;
        const app = document.querySelector('.app');
        if (app) app.classList.add('with-fallback-bar');
      }
    }

    if (inTelegram) tg.MainButton.onClick(onClick);

    return {
      show(text, fn, options = {}) {
        handler = fn;
        enabled = options.enabled !== false;
        if (inTelegram) safely(() => tg.MainButton.hideProgress());
        paint(text);
      },
      setEnabled(value) {
        enabled = value;
        paint();
      },
      progress(on) {
        if (inTelegram) {
          safely(() => (on ? tg.MainButton.showProgress(false) : tg.MainButton.hideProgress()));
        } else if (button) {
          button.disabled = on || !enabled;
        }
      },
      hide() {
        handler = null;
        if (inTelegram) tg.MainButton.hide();
        else if (bar) {
          bar.hidden = true;
          const app = document.querySelector('.app');
          if (app) app.classList.remove('with-fallback-bar');
        }
      },
    };
  })();

  const backButton = (() => {
    const native = versionAtLeast('6.1');
    let handler = null;

    function onClick() {
      if (handler) handler();
    }

    if (native) tg.BackButton.onClick(onClick);

    return {
      show(fn) {
        handler = fn;
        if (native) tg.BackButton.show();
      },
      hide() {
        handler = null;
        if (native) tg.BackButton.hide();
      },
      // Временно перехватить «Назад» (например, чтобы закрыть список); возвращает функцию отмены
      override(fn) {
        const previous = handler;
        handler = fn;
        if (native) tg.BackButton.show();
        return () => {
          handler = previous;
          if (native && !previous) tg.BackButton.hide();
        };
      },
      // Кнопка «Назад» в разметке — только там, где нет нативной кнопки Telegram
      fallback() {
        if (native || !handler) return null;
        return h('button', { class: 'fallback-back', type: 'button', onClick }, '‹ Назад');
      },
    };
  })();

  function alertBox(message) {
    return new Promise((resolve) => {
      if (versionAtLeast('6.2')) tg.showAlert(message, () => resolve());
      else {
        window.alert(message);
        resolve();
      }
    });
  }

  function confirmBox(message) {
    return new Promise((resolve) => {
      if (versionAtLeast('6.2')) tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
      else resolve(window.confirm(message));
    });
  }

  const haptic = {
    select() {
      if (versionAtLeast('6.1')) safely(() => tg.HapticFeedback.selectionChanged());
    },
    success() {
      if (versionAtLeast('6.1')) safely(() => tg.HapticFeedback.notificationOccurred('success'));
    },
    error() {
      if (versionAtLeast('6.1')) safely(() => tg.HapticFeedback.notificationOccurred('error'));
    },
  };

  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById('toast');
    if (!el) {
      el = h('div', { id: 'toast', class: 'toast', role: 'status' });
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- выпадающий список ----------

  // Замена <select>: системный список на Android и Windows рисуется по-своему и выбивается из оформления.
  // options — пары [значение, подпись]; список открывается листом снизу в цветах темы Telegram.
  function picker({ id, label, value, options, onChange }) {
    let current = value;
    const textOf = (v) => (options.find(([key]) => key === v) || [v, String(v)])[1];
    const valueEl = h('span', { class: 'picker-value' }, textOf(current));
    const button = h(
      'button',
      {
        class: 'field picker',
        type: 'button',
        id,
        'aria-haspopup': 'listbox',
        onClick: () =>
          openSheet(label, options, current, button, (v) => {
            current = v;
            valueEl.textContent = textOf(v);
            onChange(v);
          }),
      },
      h('span', { class: 'field-label' }, label),
      valueEl
    );
    return button;
  }

  function openSheet(title, options, value, opener, onSelect) {
    let closed = false;
    const restoreBack = backButton.override(close);
    const list = h(
      'div',
      { class: 'sheet-list', role: 'listbox', 'aria-label': title },
      options.map(([key, text]) =>
        h(
          'button',
          {
            class: cls('row', 'sheet-option', key === value && 'selected'),
            type: 'button',
            role: 'option',
            'aria-selected': String(key === value),
            onClick: () => {
              close();
              if (key === value) return;
              haptic.select();
              onSelect(key);
            },
          },
          h('span', { class: 'row-main' }, text),
          key === value ? h('span', { class: 'sheet-check', 'aria-hidden': 'true' }, '✓') : null
        )
      )
    );
    const overlay = h(
      'div',
      { class: 'sheet-overlay', onClick: (e) => e.target === overlay && close() },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'sheet-title' }, title), list)
    );

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    function close() {
      if (closed) return;
      closed = true;
      restoreBack();
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sheet-open');
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 180);
      opener.focus({ preventScroll: true });
    }

    document.addEventListener('keydown', onKey);
    document.body.classList.add('sheet-open');
    document.body.appendChild(overlay);
    // Выбранный пункт — по центру списка
    const selected = list.querySelector('.selected') || list.firstChild;
    if (selected) {
      list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
      selected.focus({ preventScroll: true });
    }
  }

  // ---------- форматирование ----------

  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  const pad = (n) => String(n).padStart(2, '0');

  const fmt = {
    MONTHS,
    WEEKDAYS,
    isoDate(d) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    parseDate(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    },
    weekdayIndex(d) {
      return (d.getDay() + 6) % 7;
    },
    date(iso, options = {}) {
      const d = fmt.parseDate(iso);
      let text = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
      if (options.year) text += ` ${d.getFullYear()}`;
      return `${text}, ${WEEKDAYS[fmt.weekdayIndex(d)]}`;
    },
    relativeDate(iso) {
      const today = new Date();
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      if (iso === fmt.isoDate(today)) return 'Сегодня, ' + fmt.date(iso);
      if (iso === fmt.isoDate(tomorrow)) return 'Завтра, ' + fmt.date(iso);
      return fmt.date(iso);
    },
    price(amount) {
      return `${Number(amount).toLocaleString('ru-RU')} ${window.App.currency}`;
    },
    duration(minutes) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const parts = [];
      if (hours) parts.push(`${hours} ч`);
      if (mins || !hours) parts.push(`${mins} мин`);
      return parts.join(' ');
    },
    addMinutes(time, minutes) {
      const [hh, mm] = time.split(':').map(Number);
      const total = hh * 60 + mm + minutes;
      return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
    },
    shiftMonth(month, delta) {
      const [y, m] = month.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    },
    plural(n, one, few, many) {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return one;
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
      return many;
    },
  };

  function openTelegramLink(url) {
    if (versionAtLeast('6.1')) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }

  function init() {
    if (!inTelegram) return;
    tg.ready();
    tg.expand();
    if (versionAtLeast('6.1')) {
      safely(() => tg.setHeaderColor('secondary_bg_color'));
      safely(() => tg.setBackgroundColor('secondary_bg_color'));
    }
    // Чтобы прокрутка списка не сворачивала приложение
    if (versionAtLeast('7.7')) safely(() => tg.disableVerticalSwipes());
  }

  window.App = {
    tg,
    inTelegram,
    versionAtLeast,
    h,
    cls,
    api,
    ApiError,
    mainButton,
    backButton,
    alertBox,
    confirmBox,
    haptic,
    toast,
    picker,
    fmt,
    openTelegramLink,
    init,
    currency: '₽',
  };
})();
