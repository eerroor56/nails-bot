/* Админ-панель мастера: записи клиентов, услуги, график работы. */
(function () {
  'use strict';

  const { h, cls, api, mainButton, backButton, alertBox, confirmBox, haptic, toast, fmt, openTelegramLink } =
    window.App;
  const root = document.getElementById('app');
  const fromClient = new URLSearchParams(window.location.search).get('from') === 'client';

  const DURATIONS = [];
  for (let m = 15; m <= 480; m += 15) DURATIONS.push(m);
  const HORIZONS = [7, 14, 21, 30, 45, 60, 90];
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
    view: 'loading', // loading | denied | error | tabs | service-form
    error: '',
    tab: 'bookings',
    scope: 'upcoming',
    bookings: null,
    services: null,
    schedule: null, // черновик графика
    daysOff: [],
    newDayOff: '',
    form: null, // редактируемая услуга
    saving: false,
  };

  // ---------- отрисовка ----------

  function render(scrollTop) {
    if (state.view === 'service-form') backButton.show(closeForm);
    else if (fromClient) backButton.show(() => (window.location.href = 'index.html'));
    else backButton.hide();

    const views = { loading: viewLoading, denied: viewDenied, error: viewError, tabs: viewTabs, 'service-form': viewServiceForm };
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
            placeholder: 'Например, маникюр с покрытием',
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
        h(
          'label',
          { class: 'field', for: 'svc-duration' },
          h('span', { class: 'field-label' }, 'Длительность'),
          h(
            'select',
            { class: 'input', id: 'svc-duration', value: String(form.duration_min), onChange: bind('duration_min', (t) => Number(t.value)) },
            durations.map((m) => h('option', { value: String(m) }, fmt.duration(m)))
          )
        )
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

  // ---------- график ----------

  function tabSchedule() {
    if (state.schedule === null) {
      mainButton.hide();
      return spinner();
    }
    mainButton.show('Сохранить график', saveSchedule);
    const schedule = state.schedule;

    return [
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

      h('div', { class: 'section-title' }, 'Рабочие дни'),
      h('div', { class: 'card' }, schedule.week.map(dayRow)),

      h('div', { class: 'section-title' }, 'Правила записи'),
      h(
        'div',
        { class: 'card' },
        h(
          'label',
          { class: 'field', for: 'horizon' },
          h('span', { class: 'field-label' }, 'Открыть запись вперёд на'),
          h(
            'select',
            {
              class: 'input',
              id: 'horizon',
              value: String(schedule.horizon_days),
              onChange: (e) => (schedule.horizon_days = Number(e.target.value)),
            },
            withCurrent(HORIZONS, schedule.horizon_days).map((d) =>
              h('option', { value: String(d) }, `${d} ${fmt.plural(d, 'день', 'дня', 'дней')}`)
            )
          )
        ),
        h(
          'label',
          { class: 'field', for: 'lead' },
          h('span', { class: 'field-label' }, 'Записываться не позднее чем за'),
          h(
            'select',
            {
              class: 'input',
              id: 'lead',
              value: String(schedule.min_lead_minutes),
              onChange: (e) => (schedule.min_lead_minutes = Number(e.target.value)),
            },
            withCurrentPairs(LEADS, schedule.min_lead_minutes).map(([m, label]) => h('option', { value: String(m) }, label))
          )
        )
      ),

      h('div', { class: 'section-title' }, 'Выходные и отпуск'),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'inline-form' },
          h('input', {
            class: 'input',
            type: 'date',
            'aria-label': 'Дата выходного',
            min: fmt.isoDate(new Date()),
            value: state.newDayOff,
            onInput: (e) => (state.newDayOff = e.target.value),
          }),
          h('button', { class: 'btn', type: 'button', onClick: addDayOff }, 'Добавить')
        ),
        state.daysOff.map((day) =>
          h(
            'div',
            { class: 'row' },
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, fmt.date(day, { year: true }))),
            h('button', { class: 'link-button danger', type: 'button', onClick: () => removeDayOff(day) }, 'Удалить')
          )
        )
      ),
      h('p', { class: 'section-note' }, 'В эти дни запись закрыта. Уже существующие записи не отменяются автоматически.'),
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
    const names = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    const timeInput = (key, label) =>
      h('input', {
        type: 'time',
        step: '300',
        'aria-label': `${names[index]}: ${label}`,
        value: day[key],
        onChange: (e) => (day[key] = e.target.value),
      });
    return h(
      'div',
      { class: 'row day-row' },
      h('div', { class: 'row-title', title: names[index] }, fmt.WEEKDAYS[index]),
      h(
        'div',
        { class: cls('time-range', !day.enabled && 'off') },
        day.enabled ? [timeInput('start', 'начало'), '–', timeInput('end', 'конец')] : h('span', null, 'выходной')
      ),
      h(
        'span',
        { class: 'switch' },
        h('input', {
          type: 'checkbox',
          'aria-label': `${names[index]}: рабочий день`,
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

  async function loadSchedule() {
    try {
      const data = await api('api/admin/schedule');
      state.schedule = data.schedule;
      state.daysOff = data.days_off;
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  async function saveSchedule() {
    if (state.saving) return;
    const invalid = state.schedule.week.findIndex((d) => d.enabled && (!d.start || !d.end || d.start >= d.end));
    if (invalid >= 0) {
      haptic.error();
      return alertBox(`${fmt.WEEKDAYS[invalid].toUpperCase()}: время начала должно быть раньше окончания`);
    }
    state.saving = true;
    mainButton.progress(true);
    try {
      state.schedule = await api('api/admin/schedule', { method: 'PUT', body: state.schedule });
      haptic.success();
      toast('График сохранён');
      render();
    } catch (e) {
      alertBox(e.message);
    } finally {
      state.saving = false;
      mainButton.progress(false);
    }
  }

  async function addDayOff() {
    if (!state.newDayOff) return toast('Выберите дату');
    try {
      const data = await api('api/admin/days-off', { method: 'POST', body: { date: state.newDayOff } });
      state.daysOff = data.days_off;
      state.newDayOff = '';
      haptic.success();
      render();
    } catch (e) {
      alertBox(e.message);
    }
  }

  async function removeDayOff(day) {
    try {
      const data = await api(`api/admin/days-off/${day}`, { method: 'DELETE' });
      state.daysOff = data.days_off;
      render();
    } catch (e) {
      alertBox(e.message);
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
