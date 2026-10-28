/* Админ-панель мастера: записи клиентов, услуги, график работы. */
(function () {
  'use strict';

  const { h, cls, api, mainButton, backButton, alertBox, confirmBox, haptic, toast, picker, fmt, openTelegramLink } =
    window.App;
  const root = document.getElementById('app');
  const fromClient = new URLSearchParams(window.location.search).get('from') === 'client';

  const DURATIONS = [];
  for (let m = 15; m <= 480; m += 15) DURATIONS.push(m);
  const HORIZONS = [7, 14, 21, 30, 45, 60, 90, 120, 180, 365];
  // Как DAYS_AHEAD и MAX_BREAKS на сервере: на сколько дней вперёд расписывается календарь и сколько перерывов в дне
  const DAYS_AHEAD = 365;
  const MAX_BREAKS = 5;
  const STEPS = [15, 30, 45, 60];
  const WEEKDAYS_PLURAL = ['понедельники', 'вторники', 'среды', 'четверги', 'пятницы', 'субботы', 'воскресенья'];
  const SINGLE_PICK_KEY = 'admin-single-pick';
  const LEADS = [
    [0, 'Без ограничений'],
    [30, '30 минут'],
    [60, '1 час'],
    [120, '2 часа'],
    [180, '3 часа'],
    [720, '12 часов'],
    [1440, '1 сутки'],
  ];

  const state = {
    view: 'loading', // loading | denied | error | tabs | service-form | rules
    error: '',
    tab: 'bookings',
    scope: 'upcoming',
    bookings: null,
    services: null,
    schedule: null, // правила записи: шаг, на сколько дней вперёд, за сколько до начала
    days: {}, // дата → часы работы и перерывы; дней, которых здесь нет, мастер не работает
    dayBookings: [], // будущие записи — под календарём, когда выбран день
    today: '', // сегодня по часовому поясу мастера
    calMonth: '', // месяц в календаре графика, 'YYYY-MM'
    picked: [], // выбранные в календаре даты
    singlePick: storedSinglePick(), // нажатие на день заменяет выбор, а не добавляет к нему
    dayDraft: null, // часы и перерывы для выбранных дат
    rules: null, // черновик правил записи на их экране
    form: null, // редактируемая услуга
    saving: false,
  };

  // ---------- отрисовка ----------

  function render(scrollTop) {
    if (state.view === 'service-form') backButton.show(closeForm);
    else if (state.view === 'rules') backButton.show(closeRules);
    else if (fromClient) backButton.show(() => (window.location.href = 'index.html'));
    else backButton.hide();

    const views = {
      loading: viewLoading,
      denied: viewDenied,
      error: viewError,
      tabs: viewTabs,
      'service-form': viewServiceForm,
      rules: viewRules,
    };
    root.replaceChildren(h('div', { class: cls('screen', scrollTop && 'enter') }, backButton.fallback(), views[state.view]()));
    if (scrollTop) window.scrollTo(0, 0);
  }

  function viewLoading() {
    mainButton.hide();
    return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Загрузка' });
  }

  function viewDenied() {
    mainButton.hide();
    return h(
      'div',
      { class: 'hero' },
      h('div', { class: 'hero-icon' }, '🔒'),
      h('h1', null, 'Нет доступа'),
      h('p', null, 'Админ-панель доступна только мастеру. Добавьте свой Telegram ID в ADMIN_IDS на сервере.')
    );
  }

  function viewError() {
    mainButton.show('Повторить', boot);
    return h('div', { class: 'hero' }, h('div', { class: 'hero-icon' }, '😕'), h('h1', null, 'Ошибка'), h('p', null, state.error));
  }

  function viewTabs() {
    const tabs = [
      ['bookings', 'Записи'],
      ['services', 'Услуги'],
      ['schedule', 'График'],
    ];
    const content = { bookings: tabBookings, services: tabServices, schedule: tabSchedule }[state.tab]();
    return [
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        h(
          'div',
          { class: 'tabs-inner' },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                class: cls('tab', state.tab === id && 'active'),
                type: 'button',
                role: 'tab',
                'aria-selected': String(state.tab === id),
                onClick: () => switchTab(id),
              },
              label
            )
          )
        )
      ),
      content,
    ];
  }

  function placeholder(text) {
    return h('div', { class: 'card' }, h('div', { class: 'placeholder' }, text));
  }

  function spinner() {
    return h('div', { class: 'spinner' });
  }

  // ---------- записи ----------

  function tabBookings() {
    mainButton.hide();
    const segmented = h(
      'div',
      { class: 'segmented' },
      [
        ['upcoming', 'Предстоящие'],
        ['past', 'Прошедшие'],
      ].map(([id, label]) =>
        h(
          'button',
          { class: cls(state.scope === id && 'active'), type: 'button', onClick: () => switchScope(id) },
          label
        )
      )
    );
    if (state.bookings === null) return [segmented, spinner()];
    if (!state.bookings.length) {
      return [segmented, h('div', { class: 'mt' }), placeholder(state.scope === 'upcoming' ? 'Предстоящих записей пока нет' : 'Здесь появятся прошедшие записи')];
    }

    const groups = new Map();
    for (const booking of state.bookings) {
      if (!groups.has(booking.date)) groups.set(booking.date, []);
      groups.get(booking.date).push(booking);
    }
    const active = state.bookings.filter((b) => b.status === 'active');
    const revenue = active.reduce((sum, b) => sum + b.total_price, 0);

    return [
      segmented,
      state.scope === 'upcoming'
        ? h(
            'div',
            { class: 'summary-bar' },
            h('span', null, `${active.length} ${fmt.plural(active.length, 'запись', 'записи', 'записей')}`),
            h('strong', null, fmt.price(revenue))
          )
        : null,
      [...groups].map(([date, items]) => [
        h('div', { class: 'date-header' }, fmt.relativeDate(date)),
        h('div', { class: 'card' }, items.map(bookingRow)),
      ]),
    ];
  }

  function bookingRow(booking, canCancel = state.scope === 'upcoming') {
    const cancelled = booking.status !== 'active';
    const username = booking.username
      ? h(
          'a',
          {
            href: `https://t.me/${booking.username}`,
            onClick: (e) => {
              e.preventDefault();
              openTelegramLink(`https://t.me/${booking.username}`);
            },
          },
          '@' + booking.username
        )
      : null;
    return h(
      'div',
      { class: cls('row', cancelled && 'cancelled'), style: 'align-items:flex-start' },
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, h('b', null, `${booking.time}–${booking.end_time}`), ` · ${booking.client_name}`),
        h('div', { class: 'row-sub' }, booking.services.map((s) => s.name).join(', ')),
        h(
          'div',
          { class: 'booking-meta' },
          h('a', { href: `tel:${booking.phone}` }, booking.phone),
          username,
          h('span', null, fmt.price(booking.total_price))
        ),
        cancelled
          ? h('div', { class: 'row-sub text-danger' }, booking.cancelled_by === 'client' ? 'Отменена клиентом' : 'Отменена мастером')
          : null
      ),
      !cancelled && canCancel
        ? h('button', { class: 'link-button danger', type: 'button', onClick: () => cancelBooking(booking) }, 'Отменить')
        : null
    );
  }

  async function loadBookings() {
    state.bookings = null;
    render();
    try {
      state.bookings = await api(`api/admin/bookings?scope=${state.scope}`);
    } catch (e) {
      state.bookings = [];
      toast(e.message);
    }
    render();
  }

  function switchScope(scope) {
    if (state.scope === scope) return;
    haptic.select();
    state.scope = scope;
    loadBookings();
  }

  async function cancelBooking(booking) {
    const ok = await confirmBox(
      `Отменить запись ${booking.client_name} на ${fmt.date(booking.date)}, ${booking.time}? Клиент получит уведомление.`
    );
    if (!ok) return;
    try {
      const updated = await api(`api/admin/bookings/${booking.id}/cancel`, { method: 'POST' });
      const replace = (list) => list && list.map((b) => (b.id === updated.id ? updated : b));
      state.bookings = replace(state.bookings);
      state.dayBookings = replace(state.dayBookings);
      haptic.success();
      render();
      toast('Запись отменена');
    } catch (e) {
      alertBox(e.message);
    }
  }

  // ---------- услуги ----------

  function tabServices() {
    mainButton.show('Добавить услугу', () => openForm(null));
    if (state.services === null) return spinner();
    if (!state.services.length) {
      return [
        placeholder('Услуг пока нет. Добавьте первую — клиенты сразу увидят её в приложении.'),
      ];
    }
    return [
      h(
        'div',
        { class: 'card mt' },
        state.services.map((service) =>
          h(
            'button',
            { class: cls('row', !service.is_active && 'cancelled'), type: 'button', onClick: () => openForm(service) },
            h(
              'div',
              { class: 'row-main' },
              h(
                'div',
                { class: 'row-title' },
                service.name,
                service.is_active ? null : h('span', { class: 'badge' }, 'скрыта')
              ),
              h(
                'div',
                { class: 'row-sub' },
                [fmt.duration(service.duration_min), service.description].filter(Boolean).join(' · ')
              )
            ),
            h('span', { class: 'row-value' }, fmt.price(service.price)),
            h('span', { class: 'row-value hint' }, '›')
          )
        )
      ),
      h('p', { class: 'section-note' }, 'Скрытые услуги не видны клиентам, но остаются в старых записях.'),
    ];
  }

  async function loadServices() {
    try {
      state.services = await api('api/admin/services');
    } catch (e) {
      state.services = [];
      toast(e.message);
    }
    render();
  }

  function openForm(service) {
    state.form = service
      ? { ...service, price: String(service.price) }
      : { id: null, name: '', description: '', price: '', duration_min: 60, is_active: true, sort_order: 0 };
    state.view = 'service-form';
    render(true);
  }

  function closeForm() {
    state.form = null;
    state.view = 'tabs';
    render(true);
  }

  function viewServiceForm() {
    const form = state.form;
    mainButton.show('Сохранить', saveService);
    const bind = (key, transform) => (e) => {
      form[key] = transform ? transform(e.target) : e.target.value;
    };
    const durations = DURATIONS.includes(form.duration_min) ? DURATIONS : [...DURATIONS, form.duration_min].sort((a, b) => a - b);

    return [
      h('h1', { class: 'page-title' }, form.id ? 'Редактирование услуги' : 'Новая услуга'),
      h('div', { class: 'section-title' }, 'Услуга'),
      h(
        'div',
        { class: 'card' },
        h(
          'label',
          { class: 'field', for: 'svc-name' },
          h('span', { class: 'field-label' }, 'Название'),
          h('input', {
            class: 'input',
            id: 'svc-name',
            maxlength: '100',
            placeholder: 'Например, маникюр или коррекция бровей',
            value: form.name,
            onInput: bind('name'),
          })
        ),
        h(
          'label',
          { class: 'field', for: 'svc-desc' },
          h('span', { class: 'field-label' }, 'Описание (необязательно)'),
          h('textarea', {
            class: 'input',
            id: 'svc-desc',
            rows: '2',
            maxlength: '500',
            placeholder: 'Что входит в услугу',
            value: form.description,
            onInput: bind('description'),
          })
        )
      ),
      h('div', { class: 'section-title' }, 'Цена и время'),
      h(
        'div',
        { class: 'card' },
        h(
          'label',
          { class: 'field', for: 'svc-price' },
          h('span', { class: 'field-label' }, `Цена, ${window.App.currency}`),
          // type="text": у type="number" браузер рисует стрелки-счётчик и меняет цену колесом мыши
          h('input', {
            class: 'input',
            id: 'svc-price',
            type: 'text',
            inputmode: 'numeric',
            autocomplete: 'off',
            maxlength: '7',
            placeholder: '2000',
            value: form.price,
            onInput: bind('price', (t) => (t.value = t.value.replace(/\D/g, ''))),
          })
        ),
        picker({
          id: 'svc-duration',
          label: 'Длительность',
          value: form.duration_min,
          options: durations.map((m) => [m, fmt.duration(m)]),
          onChange: (m) => (form.duration_min = m),
        })
      ),
      h(
        'div',
        { class: 'card mt' },
        h(
          'label',
          { class: 'row', for: 'svc-active' },
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, 'Показывать клиентам'),
            h('div', { class: 'row-sub' }, 'Выключите, чтобы временно скрыть услугу')
          ),
          h(
            'span',
            { class: 'switch' },
            h('input', { type: 'checkbox', id: 'svc-active', checked: form.is_active, onChange: bind('is_active', (t) => t.checked) }),
            h('span')
          )
        )
      ),
      h('div', { class: 'error-text', id: 'form-error', role: 'alert', hidden: true }),
      form.id ? h('button', { class: 'btn danger mt', type: 'button', onClick: deleteService }, 'Удалить услугу') : null,
    ];
  }

  function formError(message) {
    const el = document.getElementById('form-error');
    el.textContent = message;
    el.hidden = !message;
    if (message) haptic.error();
  }

  async function saveService() {
    if (state.saving) return;
    const form = state.form;
    const price = Number(form.price);
    if (!form.name.trim()) return formError('Укажите название услуги');
    if (form.price === '' || !Number.isInteger(price) || price < 0) return formError('Укажите цену целым числом');

    state.saving = true;
    mainButton.progress(true);
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      price,
      duration_min: form.duration_min,
      is_active: form.is_active,
      sort_order: form.sort_order || 0,
    };
    try {
      if (form.id) await api(`api/admin/services/${form.id}`, { method: 'PUT', body });
      else await api('api/admin/services', { method: 'POST', body });
      haptic.success();
      toast('Услуга сохранена');
      state.services = await api('api/admin/services');
      closeForm();
    } catch (e) {
      formError(e.message);
    } finally {
      state.saving = false;
      mainButton.progress(false);
    }
  }

  async function deleteService() {
    const ok = await confirmBox(`Удалить услугу «${state.form.name}»? Существующие записи сохранятся.`);
    if (!ok) return;
    try {
      await api(`api/admin/services/${state.form.id}`, { method: 'DELETE' });
      haptic.success();
      toast('Услуга удалена');
      state.services = await api('api/admin/services');
      closeForm();
    } catch (e) {
      alertBox(e.message);
    }
  }

  // ---------- график: календарь ----------

  function tabSchedule() {
    // Кнопка видна и пока график загружается, и без выбранных дней — только неактивная: Telegram для Android
    // после быстрых hide → show показывает текст предыдущей вкладки
    mainButton.show('Сохранить', saveDays, { enabled: state.picked.length > 0 });
    if (state.schedule === null) return spinner();

    return [
      h('div', { class: 'section-title' }, 'Календарь'),
      scheduleCalendar(),
      h(
        'div',
        { class: 'card' },
        h(
          'label',
          { class: 'row', for: 'single-pick' },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Выбирать одну дату')),
          h(
            'span',
            { class: 'switch' },
            h('input', {
              type: 'checkbox',
              id: 'single-pick',
              checked: state.singlePick,
              onChange: (e) => setSinglePick(e.target.checked),
            }),
            h('span')
          )
        )
      ),
      state.picked.length
        ? [dayEditor(), pickedBookings()]
        : [
            h(
              'p',
              { class: 'section-note' },
              'Нажмите на день, чтобы задать часы работы и перерывы или сделать его выходным, — ниже появятся и записи ' +
                'на этот день.' +
                (state.singlePick
                  ? ''
                  : ' Можно выбрать несколько дней, а нажатие на «пн», «вт»… выберет все такие дни месяца.')
            ),
            h(
              'p',
              { class: 'section-note' },
              `Клиенты могут записаться до ${fmt.date(horizonEnd(), { weekday: false })} включительно, дни после — бледные.`
            ),
          ],

      h('div', { class: 'section-title' }, 'Правила записи'),
      h(
        'div',
        { class: 'card' },
        h(
          'button',
          { class: 'row', type: 'button', onClick: openRules },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, rulesSummary(state.schedule))),
          h('span', { class: 'row-value hint' }, '›')
        )
      ),
    ];
  }

  function addDays(iso, days) {
    const d = fmt.parseDate(iso);
    d.setDate(d.getDate() + days);
    return fmt.isoDate(d);
  }

  function minutes(time) {
    const [hh, mm] = time.split(':').map(Number);
    return hh * 60 + mm;
  }

  function hhmm(total) {
    return fmt.addMinutes('00:00', total);
  }

  function weekdayOf(iso) {
    return fmt.weekdayIndex(fmt.parseDate(iso));
  }

  function lastEditableDay() {
    return addDays(state.today, DAYS_AHEAD);
  }

  function horizonEnd() {
    return addDays(state.today, state.schedule.horizon_days - 1);
  }

  function isEditable(iso) {
    return iso >= state.today && iso <= lastEditableDay();
  }

  function monthDates(month) {
    const [year, mon] = month.split('-').map(Number);
    const count = new Date(year, mon, 0).getDate();
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  }

  function hoursText(day) {
    if (!day) return 'выходной';
    const breaks = day.breaks.map((b) => `${b.start}–${b.end}`);
    return `${day.start}–${day.end}${breaks.length ? `, перерыв ${breaks.join(', ')}` : ''}`;
  }

  function activeCounts() {
    const counts = {};
    for (const b of state.dayBookings) if (b.status === 'active') counts[b.date] = (counts[b.date] || 0) + 1;
    return counts;
  }

  function scheduleCalendar() {
    const month = state.calMonth;
    const [year, mon] = month.split('-').map(Number);
    const last = lastEditableDay();
    const closedAfter = horizonEnd();
    const counts = activeCounts();

    const cells = [];
    for (let i = 0; i < fmt.weekdayIndex(new Date(year, mon - 1, 1)); i++) cells.push(h('div'));
    for (const iso of monthDates(month)) {
      const editable = isEditable(iso);
      const work = state.days[iso];
      const booked = counts[iso] || 0;
      const picked = state.picked.includes(iso);
      cells.push(
        h(
          'button',
          {
            class: cls(
              'cal-day',
              editable && (work ? 'work' : 'off'),
              editable && iso > closedAfter && 'closed',
              picked && 'selected',
              iso === state.today && 'today'
            ),
            type: 'button',
            disabled: !editable,
            'aria-pressed': String(picked),
            'aria-label': `${fmt.date(iso)}: ${hoursText(work)}${booked ? `, записей: ${booked}` : ''}`,
            onClick: () => togglePick(iso),
          },
          Number(iso.slice(8)),
          booked && editable ? h('span', { class: 'cal-badge', 'aria-hidden': 'true' }, booked) : null
        )
      );
    }

    const nav = (delta, label, symbol, disabled) =>
      h(
        'button',
        {
          class: 'cal-nav',
          type: 'button',
          'aria-label': label,
          disabled,
          onClick: () => {
            state.calMonth = fmt.shiftMonth(month, delta);
            render();
          },
        },
        symbol
      );

    return h(
      'div',
      { class: 'card calendar' },
      h(
        'div',
        { class: 'cal-head' },
        nav(-1, 'Предыдущий месяц', '‹', month <= state.today.slice(0, 7)),
        h('div', { class: 'cal-title' }, `${fmt.MONTHS[mon - 1]} ${year}`),
        nav(1, 'Следующий месяц', '›', month >= last.slice(0, 7))
      ),
      h(
        'div',
        { class: 'cal-grid' },
        fmt.WEEKDAYS.map((w, i) =>
          state.singlePick
            ? h('div', { class: 'cal-wd' }, w)
            : h(
                'button',
                {
                  class: 'cal-wd pick',
                  type: 'button',
                  'aria-label': `Выбрать все ${WEEKDAYS_PLURAL[i]} месяца`,
                  onClick: () => pickWeekday(i),
                },
                w
              )
        ),
        cells
      ),
      h(
        'div',
        { class: 'cal-legend', 'aria-hidden': 'true' },
        h('span', null, h('i', { class: 'legend-work' }), 'рабочий'),
        h('span', null, h('i', { class: 'legend-off' }), 'выходной'),
        h('span', null, h('i', { class: 'legend-booked' }, '1'), 'записи')
      )
    );
  }

  function copyDay(day) {
    return { start: day.start, end: day.end, breaks: day.breaks.map((b) => ({ ...b })) };
  }

  // Черновик часов для первого выбранного дня. У выходного часы берём с ближайшего рабочего дня —
  // лучше того же дня недели — на случай, если его решат сделать рабочим
  function draftFor(iso) {
    if (state.days[iso]) return { enabled: true, ...copyDay(state.days[iso]) };
    const target = fmt.parseDate(iso).getTime();
    let best = null;
    let bestScore = Infinity;
    for (const [date, day] of Object.entries(state.days)) {
      const score = Math.abs(fmt.parseDate(date).getTime() - target) + (weekdayOf(date) === weekdayOf(iso) ? 0 : 1e12);
      if (score < bestScore) {
        best = day;
        bestScore = score;
      }
    }
    return { enabled: false, ...copyDay(best || { start: '10:00', end: '20:00', breaks: [] }) };
  }

  function setPicked(dates) {
    if (!state.picked.length && dates.length) state.dayDraft = draftFor(dates[0]);
    state.picked = [...dates].sort();
    if (!state.picked.length) state.dayDraft = null;
    render();
  }

  function togglePick(iso) {
    haptic.select();
    if (state.picked.includes(iso)) return setPicked(state.picked.filter((d) => d !== iso));
    // По одной дате черновик часов берётся заново — с нового дня, а не с прошлого выбора
    if (state.singlePick) state.picked = [];
    setPicked([...state.picked, iso]);
  }

  // Выбор режима запоминается в браузере мастера; если хранилище недоступно, по умолчанию — несколько дат
  function storedSinglePick() {
    try {
      return window.localStorage.getItem(SINGLE_PICK_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setSinglePick(on) {
    state.singlePick = on;
    try {
      window.localStorage.setItem(SINGLE_PICK_KEY, on ? '1' : '0');
    } catch (e) {
      // без хранилища режим просто не запомнится
    }
    haptic.select();
    // Из нескольких выбранных дат остаётся первая — с неё и взят черновик часов
    if (on && state.picked.length > 1) state.picked = state.picked.slice(0, 1);
    render();
  }

  // «пн», «вт»… в шапке календаря: выбрать все такие дни месяца, а если они уже выбраны — снять выбор
  function pickWeekday(index) {
    const dates = monthDates(state.calMonth).filter((iso) => isEditable(iso) && weekdayOf(iso) === index);
    if (!dates.length) return;
    haptic.select();
    const all = dates.every((d) => state.picked.includes(d));
    const picked = new Set(state.picked);
    for (const d of dates) {
      if (all) picked.delete(d);
      else picked.add(d);
    }
    setPicked([...picked]);
  }

  function timeInput(day, key, label) {
    return h('input', {
      type: 'time',
      step: '300',
      'aria-label': label,
      value: day[key],
      onChange: (e) => (day[key] = e.target.value),
    });
  }

  function addBreak() {
    const draft = state.dayDraft;
    const start = minutes(draft.start || '10:00');
    const end = minutes(draft.end || '20:00');
    const last = draft.breaks[draft.breaks.length - 1];
    // Первый перерыв — обед в 13:00 (или середина дня, если 13:00 не рабочее), следующие — через час после предыдущего
    let from = last ? minutes(last.end) + 60 : start <= 12 * 60 && end >= 14 * 60 ? 13 * 60 : Math.floor((start + end) / 120) * 60;
    if (from + 30 > end) from = Math.max(start, end - 60);
    draft.breaks.push({ start: hhmm(from), end: hhmm(Math.min(from + 60, end)) });
    haptic.select();
    render();
  }

  function removeBreak(index) {
    state.dayDraft.breaks.splice(index, 1);
    haptic.select();
    render();
  }

  function dayEditor() {
    const picked = state.picked;
    const draft = state.dayDraft;

    const hoursRow = (label, day, remove) =>
      h(
        'div',
        { class: 'row hours-row' },
        h('div', { class: 'row-title' }, label),
        h(
          'div',
          { class: 'time-range' },
          timeInput(day, 'start', `${label}: начало`),
          '–',
          timeInput(day, 'end', `${label}: конец`)
        ),
        // У строки часов — пустое место под крестик, чтобы поля стояли ровно под полями перерывов
        remove
          ? h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Убрать перерыв', onClick: remove }, '✕')
          : h('span', { class: 'icon-spacer' })
      );

    return [
      h(
        'div',
        { class: 'section-title' },
        picked.length === 1 ? fmt.date(picked[0]) : `Выбрано ${picked.length} ${fmt.plural(picked.length, 'день', 'дня', 'дней')}`
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-pad' },
          h(
            'div',
            { class: 'segmented' },
            [
              [true, 'Работаю'],
              [false, 'Выходной'],
            ].map(([enabled, label]) =>
              h(
                'button',
                {
                  class: cls(draft.enabled === enabled && 'active'),
                  type: 'button',
                  onClick: () => {
                    if (draft.enabled === enabled) return;
                    haptic.select();
                    draft.enabled = enabled;
                    render();
                  },
                },
                label
              )
            )
          )
        ),
        draft.enabled
          ? [
              hoursRow('Часы', draft),
              draft.breaks.map((pause, i) => hoursRow('Перерыв', pause, () => removeBreak(i))),
              draft.breaks.length < MAX_BREAKS
                ? h('button', { class: 'row add-row', type: 'button', onClick: addBreak }, '+ Добавить перерыв')
                : null,
            ]
          : null,
        h(
          'div',
          { class: 'editor-actions' },
          h('button', { class: 'link-button', type: 'button', onClick: () => setPicked([]) }, 'Снять выбор')
        )
      ),
    ];
  }

  function pickedBookings() {
    const groups = state.picked
      .map((date) => [date, state.dayBookings.filter((b) => b.date === date)])
      .filter(([, items]) => items.length);
    const title = h('div', { class: 'section-title' }, 'Записи');
    if (!groups.length) {
      return [title, placeholder(state.picked.length === 1 ? 'На этот день записей нет' : 'На выбранные дни записей нет')];
    }
    if (state.picked.length === 1) return [title, h('div', { class: 'card' }, groups[0][1].map((b) => bookingRow(b, true)))];
    return [
      title,
      groups.map(([date, items]) => [
        h('div', { class: 'date-header' }, fmt.relativeDate(date)),
        h('div', { class: 'card' }, items.map((b) => bookingRow(b, true))),
      ]),
    ];
  }

  async function loadSchedule() {
    try {
      const data = await api('api/admin/schedule');
      state.today = data.today;
      state.schedule = data.schedule;
      state.days = data.days;
      state.dayBookings = data.bookings;
      if (!state.calMonth || state.calMonth < data.today.slice(0, 7)) state.calMonth = data.today.slice(0, 7);
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  function dayProblem(day) {
    if (!day.start || !day.end || day.start >= day.end) return 'Время начала работы должно быть раньше окончания';
    let previous = day.start;
    for (const pause of [...day.breaks].sort((a, b) => (a.start < b.start ? -1 : 1))) {
      if (!pause.start || !pause.end || pause.start >= pause.end) return 'У перерыва время начала должно быть раньше окончания';
      if (pause.start < previous || pause.end > day.end) return 'Перерывы должны быть внутри рабочего времени и не пересекаться';
      previous = pause.end;
    }
    return '';
  }

  // Помещается ли запись в новые часы работы: не раньше начала, не позже конца и не в перерыв
  function fitsDay(booking, day) {
    if (!day || booking.start_min < minutes(day.start) || booking.end_min > minutes(day.end)) return false;
    return day.breaks.every((b) => booking.end_min <= minutes(b.start) || booking.start_min >= minutes(b.end));
  }

  async function saveDays() {
    if (state.saving || !state.picked.length) return;
    const draft = state.dayDraft;
    let day = null;
    if (draft.enabled) {
      const problem = dayProblem(draft);
      if (problem) {
        haptic.error();
        return alertBox(problem);
      }
      day = copyDay(draft);
    }
    const clashes = state.dayBookings.filter((b) => b.status === 'active' && state.picked.includes(b.date) && !fitsDay(b, day));
    if (clashes.length) {
      const where = new Set(clashes.map((b) => b.date)).size === 1 ? `На ${fmt.date(clashes[0].date, { weekday: false })}` : 'На выбранные дни';
      const ok = await confirmBox(
        `${where} есть записи${day ? ' вне нового времени работы' : ''}. Они не отменятся сами — если нужно, ` +
          'отмените их в списке под календарём. Всё равно сохранить?'
      );
      if (!ok) return;
    }

    state.saving = true;
    mainButton.progress(true);
    try {
      const data = await api('api/admin/days', { method: 'PUT', body: { dates: state.picked, day } });
      state.days = data.days;
      state.picked = [];
      state.dayDraft = null;
      haptic.success();
      toast('Сохранено');
    } catch (e) {
      alertBox(e.message);
    }
    state.saving = false;
    // До перерисовки: hideProgress() включает кнопку, а без выбранных дней она должна стать неактивной
    mainButton.progress(false);
    render();
  }

  // ---------- график: правила записи ----------

  function stepText(step) {
    return step === 60 ? '1 час' : `${step} минут`;
  }

  function rulesSummary(schedule) {
    const lead = LEADS.find(([m]) => m === schedule.min_lead_minutes);
    const days = schedule.horizon_days;
    return [
      `Шаг ${stepText(schedule.slot_step)}`,
      `запись на ${days} ${fmt.plural(days, 'день', 'дня', 'дней')} вперёд`,
      schedule.min_lead_minutes ? `не позднее чем за ${lead ? lead[1] : fmt.duration(schedule.min_lead_minutes)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function openRules() {
    state.rules = { ...state.schedule };
    state.view = 'rules';
    render(true);
  }

  function closeRules() {
    state.rules = null;
    state.view = 'tabs';
    render(true);
  }

  function viewRules() {
    mainButton.show('Сохранить', saveRules);
    const rules = state.rules;

    return [
      h('h1', { class: 'page-title' }, 'Правила записи'),
      h('div', { class: 'section-title' }, 'Шаг записи'),
      h(
        'div',
        { class: 'card card-pad' },
        h(
          'div',
          { class: 'segmented' },
          STEPS.map((step) =>
            h(
              'button',
              {
                class: cls(rules.slot_step === step && 'active'),
                type: 'button',
                onClick: () => {
                  haptic.select();
                  rules.slot_step = step;
                  render();
                },
              },
              step === 60 ? '1 час' : `${step} мин`
            )
          )
        )
      ),
      h(
        'p',
        { class: 'section-note' },
        `С каким интервалом клиентам предлагается время: ${slotExample(rules.slot_step)} После перерыва отсчёт начинается заново.`
      ),

      h('div', { class: 'section-title' }, 'Когда можно записаться'),
      h(
        'div',
        { class: 'card' },
        picker({
          id: 'horizon',
          label: 'Открыть запись вперёд на',
          value: rules.horizon_days,
          options: withCurrent(HORIZONS, rules.horizon_days).map((d) => [d, `${d} ${fmt.plural(d, 'день', 'дня', 'дней')}`]),
          onChange: (d) => (rules.horizon_days = d),
        }),
        picker({
          id: 'lead',
          label: 'Записываться не позднее чем за',
          value: rules.min_lead_minutes,
          options: withCurrentPairs(LEADS, rules.min_lead_minutes),
          onChange: (m) => (rules.min_lead_minutes = m),
        })
      ),
      h('p', { class: 'section-note' }, 'Дни дальше этого срока клиенты пока не видят, даже если они рабочие в календаре.'),
    ];
  }

  function slotExample(step) {
    return [0, step, step * 2].map((m) => fmt.addMinutes('10:00', m)).join(', ') + '…';
  }

  function withCurrent(values, current) {
    return values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  }

  function withCurrentPairs(pairs, current) {
    if (pairs.some(([m]) => m === current)) return pairs;
    return [...pairs, [current, fmt.duration(current)]].sort((a, b) => a[0] - b[0]);
  }

  async function saveRules() {
    if (state.saving) return;
    state.saving = true;
    mainButton.progress(true);
    let saved = false;
    try {
      state.schedule = await api('api/admin/schedule', { method: 'PUT', body: state.rules });
      saved = true;
    } catch (e) {
      alertBox(e.message);
    }
    state.saving = false;
    // До перехода на календарь: там кнопка неактивна, пока не выбраны дни, а hideProgress() её включает
    mainButton.progress(false);
    if (saved) {
      haptic.success();
      toast('Правила записи сохранены');
      closeRules();
    }
  }

  // ---------- старт ----------

  function switchTab(tab) {
    if (state.tab === tab) return;
    haptic.select();
    state.tab = tab;
    render(true);
    if (tab === 'bookings') loadBookings();
    if (tab === 'services' && state.services === null) loadServices();
    if (tab === 'schedule') {
      state.schedule = null;
      state.picked = [];
      state.dayDraft = null;
      loadSchedule();
    }
  }

  async function boot() {
    state.view = 'loading';
    render();
    try {
      const me = await api('api/me');
      window.App.currency = me.currency;
      if (!me.is_admin) {
        state.view = 'denied';
        return render();
      }
      state.view = 'tabs';
      render();
      loadBookings();
      loadServices();
    } catch (e) {
      state.error = e.message;
      state.view = 'error';
      render();
    }
  }

  window.App.init();
  boot();
})();
