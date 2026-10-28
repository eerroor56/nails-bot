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
  // На сколько дней вперёд можно менять дни в календаре — как SPECIAL_DAYS_AHEAD на сервере
  const SPECIAL_DAYS_AHEAD = 365;
  const WEEKDAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
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
    view: 'loading', // loading | denied | error | tabs | service-form | week
    error: '',
    tab: 'bookings',
    scope: 'upcoming',
    bookings: null,
    services: null,
    schedule: null, // сохранённые обычная неделя и правила записи
    special: {}, // дата → свои часы или выходной, заданные в календаре
    booked: {}, // дата → сколько на неё активных записей
    today: '', // сегодня по часовому поясу мастера
    calMonth: '', // месяц в календаре графика, 'YYYY-MM'
    picked: [], // выбранные в календаре даты
    dayDraft: null, // часы для выбранных дат
    week: null, // черновик обычной недели на её экране
    form: null, // редактируемая услуга
    saving: false,
  };

  // ---------- отрисовка ----------

  function render(scrollTop) {
    if (state.view === 'service-form') backButton.show(closeForm);
    else if (state.view === 'week') backButton.show(closeWeek);
    else if (fromClient) backButton.show(() => (window.location.href = 'index.html'));
    else backButton.hide();

    const views = {
      loading: viewLoading,
      denied: viewDenied,
      error: viewError,
      tabs: viewTabs,
      'service-form': viewServiceForm,
      week: viewWeek,
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

  function bookingRow(booking) {
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
      !cancelled && state.scope === 'upcoming'
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
      state.bookings = state.bookings.map((b) => (b.id === updated.id ? updated : b));
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
    const schedule = state.schedule;

    return [
      h('div', { class: 'section-title' }, 'Календарь'),
      scheduleCalendar(),
      state.picked.length
        ? dayEditor()
        : h(
            'p',
            { class: 'section-note' },
            'Нажмите на день, чтобы изменить часы работы или сделать его выходным. Можно выбрать сразу несколько дней — ' +
              `например, весь отпуск. Клиенты могут записаться до ${fmt.date(horizonEnd(), { weekday: false })} включительно, дни после — бледные.`
          ),

      h('div', { class: 'section-title' }, 'Обычная неделя'),
      h(
        'div',
        { class: 'card' },
        h(
          'button',
          { class: 'row', type: 'button', onClick: openWeek },
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, weekSummary(schedule.week)),
            h('div', { class: 'row-sub' }, rulesSummary(schedule))
          ),
          h('span', { class: 'row-value hint' }, '›')
        )
      ),
      h('p', { class: 'section-note' }, 'Повторяется каждую неделю. Дни, изменённые в календаре, важнее неё.'),
    ];
  }

  function addDays(iso, days) {
    const d = fmt.parseDate(iso);
    d.setDate(d.getDate() + days);
    return fmt.isoDate(d);
  }

  function lastEditableDay() {
    return addDays(state.today, SPECIAL_DAYS_AHEAD);
  }

  function horizonEnd() {
    return addDays(state.today, state.schedule.horizon_days - 1);
  }

  function weekDay(iso) {
    return state.schedule.week[fmt.weekdayIndex(fmt.parseDate(iso))];
  }

  // Часы дня: из календаря, если день меняли, иначе из обычной недели
  function daySchedule(iso) {
    return state.special[iso] || weekDay(iso);
  }

  function hoursText(day) {
    return day.enabled ? `${day.start}–${day.end}` : 'выходной';
  }

  function scheduleCalendar() {
    const month = state.calMonth;
    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const last = lastEditableDay();
    const closedAfter = horizonEnd();

    const cells = [];
    for (let i = 0; i < fmt.weekdayIndex(new Date(year, mon - 1, 1)); i++) cells.push(h('div'));
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${month}-${String(day).padStart(2, '0')}`;
      const editable = iso >= state.today && iso <= last;
      const sched = daySchedule(iso);
      const booked = state.booked[iso] || 0;
      const picked = state.picked.includes(iso);
      cells.push(
        h(
          'button',
          {
            class: cls(
              'cal-day',
              editable && (sched.enabled ? 'work' : 'off'),
              editable && iso in state.special && 'special',
              editable && iso > closedAfter && 'closed',
              picked && 'selected',
              iso === state.today && 'today'
            ),
            type: 'button',
            disabled: !editable,
            'aria-pressed': String(picked),
            'aria-label': `${fmt.date(iso)}: ${hoursText(sched)}${booked ? `, записей: ${booked}` : ''}`,
            onClick: () => togglePick(iso),
          },
          day,
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
      h('div', { class: 'cal-grid' }, fmt.WEEKDAYS.map((w) => h('div', { class: 'cal-wd' }, w)), cells),
      h(
        'div',
        { class: 'cal-legend', 'aria-hidden': 'true' },
        h('span', null, h('i', { class: 'legend-work' }), 'рабочий'),
        h('span', null, h('i', { class: 'legend-off' }), 'выходной'),
        h('span', null, h('i', { class: 'legend-special' }), 'изменён'),
        h('span', null, h('i', { class: 'legend-booked' }, '1'), 'записи')
      )
    );
  }

  // Черновик часов для первого выбранного дня. У выходного часы берём из обычной недели —
  // на случай, если его решат сделать рабочим
  function draftFor(iso) {
    const day = daySchedule(iso);
    const usual = weekDay(iso);
    return day.enabled || !usual.enabled ? { ...day } : { ...usual, enabled: false };
  }

  function togglePick(iso) {
    haptic.select();
    if (state.picked.includes(iso)) {
      state.picked = state.picked.filter((d) => d !== iso);
    } else {
      if (!state.picked.length) state.dayDraft = draftFor(iso);
      state.picked = [...state.picked, iso].sort();
    }
    if (!state.picked.length) state.dayDraft = null;
    render();
  }

  function clearPicked() {
    state.picked = [];
    state.dayDraft = null;
    render();
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

  function dayEditor() {
    const picked = state.picked;
    const draft = state.dayDraft;
    const one = picked.length === 1;
    const booked = picked.reduce((sum, d) => sum + (state.booked[d] || 0), 0);
    const anySpecial = picked.some((d) => d in state.special);

    const notes = [];
    if (one) notes.push(`По обычной неделе: ${hoursText(weekDay(picked[0]))}.`);
    if (booked) {
      notes.push(
        `На ${one ? 'этот день' : 'эти дни'} уже есть ${booked} ` +
          `${fmt.plural(booked, 'запись', 'записи', 'записей')}. ` +
          (booked === 1
            ? 'Она не отменится сама — если нужно, отмените её во вкладке «Записи».'
            : 'Они не отменятся сами — если нужно, отмените их во вкладке «Записи».')
      );
    }
    if (picked.some((d) => d > horizonEnd())) {
      const days = state.schedule.horizon_days;
      notes.push(`Запись на ${one ? 'этот день' : 'эти дни'} откроется за ${days} ${fmt.plural(days, 'день', 'дня', 'дней')}.`);
    }

    return [
      h(
        'div',
        { class: 'section-title' },
        one ? fmt.date(picked[0]) : `Выбрано ${picked.length} ${fmt.plural(picked.length, 'день', 'дня', 'дней')}`
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
          ? h(
              'div',
              { class: 'row' },
              h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Часы')),
              h(
                'div',
                { class: 'time-range' },
                timeInput(draft, 'start', 'Начало работы'),
                '–',
                timeInput(draft, 'end', 'Конец работы')
              )
            )
          : null,
        h(
          'div',
          { class: 'editor-actions' },
          anySpecial
            ? h('button', { class: 'link-button', type: 'button', onClick: resetDays }, 'Как в обычной неделе')
            : h('span'),
          h('button', { class: 'link-button', type: 'button', onClick: clearPicked }, 'Снять выбор')
        )
      ),
      notes.length ? h('p', { class: 'section-note' }, notes.join(' ')) : null,
    ];
  }

  async function loadSchedule() {
    try {
      const data = await api('api/admin/schedule');
      state.today = data.today;
      state.schedule = data.schedule;
      state.special = data.special_days;
      state.booked = data.booked;
      if (!state.calMonth || state.calMonth < data.today.slice(0, 7)) state.calMonth = data.today.slice(0, 7);
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  async function saveDays() {
    if (state.saving || !state.picked.length) return;
    const day = state.dayDraft;
    if (day.enabled && (!day.start || !day.end || day.start >= day.end)) {
      haptic.error();
      return alertBox('Время начала работы должно быть раньше окончания');
    }
    const booked = state.picked.filter((d) => state.booked[d]);
    if (!day.enabled && booked.length) {
      const where = booked.length === 1 ? `На ${fmt.date(booked[0])}` : 'На выбранные дни';
      const ok = await confirmBox(
        `${where} уже есть записи. Они не отменятся сами — если нужно, отмените их во вкладке «Записи». Сделать выходным?`
      );
      if (!ok) return;
    }
    // У выходного часы не важны, но сервер ждёт их в формате ЧЧ:ММ
    const body = day.enabled ? day : { ...day, start: day.start || '10:00', end: day.end || '20:00' };
    await applyDays(body, 'Сохранено');
  }

  function resetDays() {
    applyDays(null, 'Вернули обычную неделю');
  }

  async function applyDays(day, message) {
    if (state.saving) return;
    state.saving = true;
    mainButton.progress(true);
    try {
      const data = await api('api/admin/special-days', { method: 'PUT', body: { dates: state.picked, day } });
      state.special = data.special_days;
      state.picked = [];
      state.dayDraft = null;
      haptic.success();
      toast(message);
    } catch (e) {
      alertBox(e.message);
    }
    state.saving = false;
    // До перерисовки: hideProgress() включает кнопку, а без выбранных дней она должна стать неактивной
    mainButton.progress(false);
    render();
  }

  // ---------- график: обычная неделя и правила записи ----------

  function weekSummary(week) {
    const parts = [];
    for (let i = 0; i < 7; ) {
      let j = i;
      while (j < 6 && hoursText(week[j + 1]) === hoursText(week[i])) j++;
      const days = i === j ? fmt.WEEKDAYS[i] : `${fmt.WEEKDAYS[i]}–${fmt.WEEKDAYS[j]}`;
      parts.push(`${days} ${hoursText(week[i])}`);
      i = j + 1;
    }
    return parts.join(', ');
  }

  function rulesSummary(schedule) {
    const lead = LEADS.find(([m]) => m === schedule.min_lead_minutes);
    const days = schedule.horizon_days;
    return [
      `Шаг ${schedule.slot_step === 60 ? '1 час' : '30 минут'}`,
      `запись на ${days} ${fmt.plural(days, 'день', 'дня', 'дней')} вперёд`,
      schedule.min_lead_minutes
        ? `не позднее чем за ${lead ? lead[1] : fmt.duration(schedule.min_lead_minutes)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function openWeek() {
    state.week = JSON.parse(JSON.stringify(state.schedule));
    state.view = 'week';
    render(true);
  }

  function closeWeek() {
    state.week = null;
    state.view = 'tabs';
    render(true);
  }

  function viewWeek() {
    mainButton.show('Сохранить', saveWeek);
    const schedule = state.week;

    return [
      h('h1', { class: 'page-title' }, 'Обычная неделя'),
      h('div', { class: 'section-title' }, 'Рабочие дни'),
      h('div', { class: 'card' }, schedule.week.map(dayRow)),
      h('p', { class: 'section-note' }, 'Если какой-то день отличается — поменяйте его в календаре на вкладке «График».'),

      h('div', { class: 'section-title' }, 'Шаг записи'),
      h(
        'div',
        { class: 'card card-pad' },
        h(
          'div',
          { class: 'segmented' },
          [
            [30, '30 минут'],
            [60, '1 час'],
          ].map(([step, label]) =>
            h(
              'button',
              {
                class: cls(schedule.slot_step === step && 'active'),
                type: 'button',
                onClick: () => {
                  haptic.select();
                  schedule.slot_step = step;
                  render();
                },
              },
              label
            )
          )
        )
      ),
      h('p', { class: 'section-note' }, 'С каким интервалом клиентам предлагается время: 10:00, 10:30… или 10:00, 11:00…'),

      h('div', { class: 'section-title' }, 'Правила записи'),
      h(
        'div',
        { class: 'card' },
        picker({
          id: 'horizon',
          label: 'Открыть запись вперёд на',
          value: schedule.horizon_days,
          options: withCurrent(HORIZONS, schedule.horizon_days).map((d) => [d, `${d} ${fmt.plural(d, 'день', 'дня', 'дней')}`]),
          onChange: (d) => (schedule.horizon_days = d),
        }),
        picker({
          id: 'lead',
          label: 'Записываться не позднее чем за',
          value: schedule.min_lead_minutes,
          options: withCurrentPairs(LEADS, schedule.min_lead_minutes),
          onChange: (m) => (schedule.min_lead_minutes = m),
        })
      ),
    ];
  }

  function withCurrent(values, current) {
    return values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  }

  function withCurrentPairs(pairs, current) {
    if (pairs.some(([m]) => m === current)) return pairs;
    return [...pairs, [current, fmt.duration(current)]].sort((a, b) => a[0] - b[0]);
  }

  function dayRow(day, index) {
    return h(
      'div',
      { class: 'row day-row' },
      h('div', { class: 'row-title', title: WEEKDAY_NAMES[index] }, fmt.WEEKDAYS[index]),
      h(
        'div',
        { class: cls('time-range', !day.enabled && 'off') },
        day.enabled
          ? [timeInput(day, 'start', `${WEEKDAY_NAMES[index]}: начало`), '–', timeInput(day, 'end', `${WEEKDAY_NAMES[index]}: конец`)]
          : h('span', null, 'выходной')
      ),
      h(
        'span',
        { class: 'switch' },
        h('input', {
          type: 'checkbox',
          'aria-label': `${WEEKDAY_NAMES[index]}: рабочий день`,
          checked: day.enabled,
          onChange: (e) => {
            haptic.select();
            day.enabled = e.target.checked;
            render();
          },
        }),
        h('span')
      )
    );
  }

  async function saveWeek() {
    if (state.saving) return;
    const invalid = state.week.week.findIndex((d) => d.enabled && (!d.start || !d.end || d.start >= d.end));
    if (invalid >= 0) {
      haptic.error();
      return alertBox(`${fmt.WEEKDAYS[invalid].toUpperCase()}: время начала должно быть раньше окончания`);
    }
    state.saving = true;
    mainButton.progress(true);
    let saved = false;
    try {
      state.schedule = await api('api/admin/schedule', { method: 'PUT', body: state.week });
      saved = true;
    } catch (e) {
      alertBox(e.message);
    }
    state.saving = false;
    // До перехода на календарь: там кнопка неактивна, пока не выбраны дни, а hideProgress() её включает
    mainButton.progress(false);
    if (saved) {
      haptic.success();
      toast('Обычная неделя сохранена');
      closeWeek();
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
