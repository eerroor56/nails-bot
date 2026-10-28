/* Клиентская часть: главная → услуги → дата и время → контакты → подтверждение. */
(function () {
  'use strict';

  const { tg, inTelegram, versionAtLeast, h, cls, api, mainButton, backButton, alertBox, confirmBox, haptic, toast, fmt } =
    window.App;
  const root = document.getElementById('app');

  const state = {
    screen: 'loading',
    error: '',
    me: null,
    services: [],
    selected: [], // id услуг в порядке выбора
    month: null, // 'YYYY-MM'
    calendar: null,
    calendarLoading: false,
    date: null,
    slots: null,
    slotsLoading: false,
    time: null,
    name: '',
    phone: '',
    bookings: [],
    lastBooking: null,
    submitting: false,
  };
  const history = [];
  let calendarRequest = 0;
  let slotsRequest = 0;

  // ---------- навигация ----------

  function render(scrollTop) {
    if (history.length && state.screen !== 'success') backButton.show(back);
    else backButton.hide();

    const view = SCREENS[state.screen]();
    root.replaceChildren(view);
    if (scrollTop) {
      // Анимация — только при переходе между экранами, а не при каждом нажатии
      view.classList.add('enter');
      window.scrollTo(0, 0);
    }
  }

  function go(screen) {
    history.push(state.screen);
    state.screen = screen;
    onEnter(screen);
    render(true);
  }

  function back() {
    state.screen = history.pop() || 'home';
    onEnter(state.screen);
    render(true);
  }

  function reset(screen) {
    history.length = 0;
    state.screen = screen;
    onEnter(screen);
    render(true);
  }

  function onEnter(screen) {
    if (screen === 'datetime' && !state.calendar && !state.calendarLoading) {
      loadCalendar(state.month || fmt.isoDate(new Date()).slice(0, 7), true);
    }
  }

  // ---------- общие куски разметки ----------

  function screen(...children) {
    return h('div', { class: 'screen' }, backButton.fallback(), children);
  }

  function steps(current) {
    return h(
      'div',
      { class: 'steps', 'aria-label': `Шаг ${current} из 4` },
      [1, 2, 3, 4].map((i) => h('span', { class: i <= current ? 'done' : '' }))
    );
  }

  function title(text, subtitle) {
    return [h('h1', { class: 'page-title' }, text), subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null];
  }

  function chosenServices() {
    return state.selected.map((id) => state.services.find((s) => s.id === id)).filter(Boolean);
  }

  function totals() {
    const chosen = chosenServices();
    return {
      price: chosen.reduce((sum, s) => sum + s.price, 0),
      duration: chosen.reduce((sum, s) => sum + s.duration_min, 0),
    };
  }

  function infoRow(label, value, className) {
    return h(
      'div',
      { class: cls('row', className) },
      h('div', { class: 'row-main' }, h('div', { class: 'row-sub' }, label), h('div', { class: 'row-title' }, value))
    );
  }

  function resetDateTime() {
    calendarRequest++;
    slotsRequest++;
    state.calendar = null;
    state.calendarLoading = false;
    state.date = null;
    state.slots = null;
    state.slotsLoading = false;
    state.time = null;
  }

  // ---------- экраны ----------

  function screenLoading() {
    mainButton.hide();
    return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Загрузка' });
  }

  function screenError() {
    mainButton.show('Повторить', boot);
    return screen(
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'hero-icon' }, '😕'),
        h('h1', null, 'Что-то пошло не так'),
        h('p', null, state.error)
      )
    );
  }

  function screenHome() {
    const me = state.me;
    mainButton.show('Записаться', startBooking);
    return screen(
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'hero-icon' }, '✨'),
        h('h1', null, me.first_name ? `Здравствуйте, ${me.first_name}!` : 'Здравствуйте!'),
        h(
          'p',
          null,
          'Онлайн-запись к мастеру. Выберите услугу и удобное время — мастер сразу получит вашу заявку.'
        )
      ),
      h(
        'div',
        { class: 'features' },
        h('div', { class: 'feature' }, h('b', null, '✨'), 'Услуга'),
        h('div', { class: 'feature' }, h('b', null, '🗓'), 'Дата и время'),
        h('div', { class: 'feature' }, h('b', null, '✅'), 'Готово')
      ),
      state.bookings.length
        ? [h('div', { class: 'section-title' }, 'Мои записи'), h('div', { class: 'card' }, state.bookings.map(myBookingRow))]
        : null,
      me.is_admin
        ? h(
            'div',
            { class: 'card mt' },
            h(
              'button',
              { class: 'row', type: 'button', onClick: () => (window.location.href = 'admin.html?from=client') },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, '⚙️ Админ-панель'),
                h('div', { class: 'row-sub' }, 'Услуги, график работы и записи клиентов')
              ),
              h('span', { class: 'row-value hint' }, '›')
            )
          )
        : null
    );
  }

  function myBookingRow(booking) {
    return h(
      'div',
      { class: 'row booking-card' },
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, `${fmt.relativeDate(booking.date)}, ${booking.time}`),
        h(
          'div',
          { class: 'row-sub' },
          `${booking.services.map((s) => s.name).join(', ')} · ${fmt.price(booking.total_price)}`
        )
      ),
      h('button', { class: 'link-button danger', type: 'button', onClick: () => cancelBooking(booking) }, 'Отменить')
    );
  }

  function screenServices() {
    const count = state.selected.length;
    const sum = totals();
    mainButton.show(count ? 'Выбрать время' : 'Выберите услугу', () => go('datetime'), { enabled: count > 0 });
    return screen(
      steps(1),
      title('Выберите услуги', 'Можно отметить несколько — время рассчитаем автоматически'),
      state.services.length
        ? h('div', { class: 'card' }, state.services.map(serviceRow))
        : h('div', { class: 'card' }, h('div', { class: 'placeholder' }, 'Мастер ещё не добавил услуги. Загляните чуть позже 🙏')),
      count
        ? h(
            'div',
            { class: 'summary-bar' },
            h('span', null, `${count} ${fmt.plural(count, 'услуга', 'услуги', 'услуг')} · ${fmt.duration(sum.duration)}`),
            h('strong', null, fmt.price(sum.price))
          )
        : null
    );
  }

  function serviceRow(service) {
    const selected = state.selected.includes(service.id);
    return h(
      'button',
      {
        class: cls('row', selected && 'selected'),
        type: 'button',
        role: 'checkbox',
        'aria-checked': String(selected),
        'aria-label': `${service.name}, ${fmt.duration(service.duration_min)}, ${fmt.price(service.price)}`,
        onClick: () => toggleService(service.id),
      },
      h('span', { class: 'check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, service.name),
        h(
          'div',
          { class: 'row-sub' },
          [fmt.duration(service.duration_min), service.description].filter(Boolean).join(' · ')
        )
      ),
      h('span', { class: 'row-value' }, fmt.price(service.price))
    );
  }

  function screenDatetime() {
    const sum = totals();
    mainButton.show('Далее', () => go('contacts'), { enabled: Boolean(state.time) });
    return screen(
      steps(2),
      title('Дата и время', `Процедура займёт ${fmt.duration(sum.duration)}`),
      calendarView(),
      h('div', { class: 'section-title' }, state.date ? `Время · ${fmt.date(state.date)}` : 'Время'),
      h('div', { class: 'card' }, slotsView())
    );
  }

  function calendarView() {
    const cal = state.calendar;
    const month = state.month || fmt.isoDate(new Date()).slice(0, 7);
    const [year, mon] = month.split('-').map(Number);
    const first = new Date(year, mon - 1, 1);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const today = fmt.isoDate(new Date());
    const loading = state.calendarLoading || !cal;

    const cells = [];
    for (let i = 0; i < fmt.weekdayIndex(first); i++) cells.push(h('div'));
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${month}-${String(day).padStart(2, '0')}`;
      const available = !loading && cal.days[iso] > 0;
      cells.push(
        h(
          'button',
          {
            class: cls('cal-day', available && 'available', iso === state.date && 'selected', iso === today && 'today'),
            type: 'button',
            disabled: !available,
            'aria-label': fmt.date(iso),
            onClick: () => {
              haptic.select();
              selectDate(iso);
            },
          },
          day
        )
      );
    }

    return h(
      'div',
      { class: 'card calendar' },
      h(
        'div',
        { class: 'cal-head' },
        h(
          'button',
          {
            class: 'cal-nav',
            type: 'button',
            'aria-label': 'Предыдущий месяц',
            disabled: loading || month <= cal.min_month,
            onClick: () => loadCalendar(fmt.shiftMonth(month, -1)),
          },
          '‹'
        ),
        h('div', { class: 'cal-title' }, `${fmt.MONTHS[mon - 1]} ${year}`),
        h(
          'button',
          {
            class: 'cal-nav',
            type: 'button',
            'aria-label': 'Следующий месяц',
            disabled: loading || month >= cal.max_month,
            onClick: () => loadCalendar(fmt.shiftMonth(month, 1)),
          },
          '›'
        )
      ),
      h('div', { class: 'cal-grid' }, fmt.WEEKDAYS.map((w) => h('div', { class: 'cal-wd' }, w)), cells)
    );
  }

  function slotsView() {
    if (state.calendarLoading || !state.calendar) return h('div', { class: 'placeholder' }, 'Загружаем расписание…');
    if (!state.date) {
      return h(
        'div',
        { class: 'placeholder' },
        Object.keys(state.calendar.days).length
          ? 'Выберите дату в календаре'
          : 'В этом месяце свободных окон нет — загляните в следующий'
      );
    }
    if (state.slotsLoading || !state.slots) return h('div', { class: 'placeholder' }, 'Загружаем время…');
    if (!state.slots.length) return h('div', { class: 'placeholder' }, 'На этот день свободного времени не осталось');
    return h(
      'div',
      { class: 'slots', role: 'radiogroup' },
      state.slots.map((slot) =>
        h(
          'button',
          {
            class: cls('slot', slot === state.time && 'selected'),
            type: 'button',
            role: 'radio',
            'aria-checked': String(slot === state.time),
            onClick: () => {
              haptic.select();
              state.time = slot;
              render();
            },
          },
          slot
        )
      )
    );
  }

  function screenContacts() {
    mainButton.show('Далее', submitContacts);
    const canShare = versionAtLeast('6.9');
    const nameInput = h('input', {
      class: 'input',
      id: 'name',
      type: 'text',
      autocomplete: 'name',
      maxlength: '64',
      placeholder: 'Как к вам обращаться',
      enterkeyhint: 'next',
      value: state.name,
      onInput: (e) => {
        state.name = e.target.value;
        showContactsError('');
      },
      onKeydown: (e) => {
        if (e.key === 'Enter') document.getElementById('phone').focus();
      },
    });
    const phoneInput = h('input', {
      class: 'input',
      id: 'phone',
      type: 'tel',
      inputmode: 'tel',
      autocomplete: 'tel',
      maxlength: '20',
      placeholder: '+7 999 123-45-67',
      enterkeyhint: 'done',
      value: state.phone,
      onInput: (e) => {
        state.phone = e.target.value;
        showContactsError('');
      },
      onKeydown: (e) => {
        if (e.key === 'Enter') submitContacts();
      },
    });
    return screen(
      steps(3),
      title('Контактные данные', 'Мастер свяжется с вами, если что-то изменится'),
      h(
        'div',
        { class: 'card' },
        h('label', { class: 'field', for: 'name' }, h('span', { class: 'field-label' }, 'Имя'), nameInput),
        h('label', { class: 'field', for: 'phone' }, h('span', { class: 'field-label' }, 'Телефон'), phoneInput)
      ),
      canShare
        ? h('button', { class: 'btn secondary mt', type: 'button', onClick: requestPhone }, '📱 Взять номер из Telegram')
        : null,
      h('div', { class: 'error-text', id: 'contacts-error', role: 'alert', hidden: true })
    );
  }

  function screenConfirm() {
    const sum = totals();
    mainButton.show('Подтвердить запись', submitBooking);
    return screen(
      steps(4),
      title('Проверьте запись', 'Если всё верно — подтвердите'),
      h('div', { class: 'section-title' }, 'Услуги'),
      h(
        'div',
        { class: 'card' },
        chosenServices().map((s) =>
          h(
            'div',
            { class: 'row' },
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'row-title' }, s.name),
              h('div', { class: 'row-sub' }, fmt.duration(s.duration_min))
            ),
            h('span', { class: 'row-value' }, fmt.price(s.price))
          )
        ),
        h(
          'div',
          { class: 'row total-row' },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Итого')),
          h('span', { class: 'row-value' }, fmt.price(sum.price))
        )
      ),
      h('div', { class: 'section-title' }, 'Когда'),
      h(
        'div',
        { class: 'card' },
        infoRow('Дата', fmt.date(state.date, { year: true })),
        infoRow('Время', `${state.time} – ${fmt.addMinutes(state.time, sum.duration)} (${fmt.duration(sum.duration)})`)
      ),
      h('div', { class: 'section-title' }, 'Контакты'),
      h('div', { class: 'card' }, infoRow('Имя', state.name.trim()), infoRow('Телефон', state.phone.trim())),
      h('p', { class: 'section-note' }, 'После подтверждения бот пришлёт сообщение с деталями записи.')
    );
  }

  function screenSuccess() {
    const booking = state.lastBooking;
    mainButton.show('Готово', () => (inTelegram ? tg.close() : reset('home')));
    return screen(
      h(
        'div',
        { class: 'success' },
        h('div', { class: 'success-icon', 'aria-hidden': 'true' }, '✓'),
        h('h1', null, 'Вы записаны!'),
        h('p', null, 'Подтверждение уже в чате с ботом. До встречи!')
      ),
      h(
        'div',
        { class: 'card' },
        infoRow('Дата и время', `${fmt.date(booking.date, { year: true })}, ${booking.time}`),
        infoRow('Услуги', booking.services.map((s) => s.name).join(', ')),
        infoRow('Сумма', fmt.price(booking.total_price))
      ),
      h('button', { class: 'btn secondary mt', type: 'button', onClick: () => reset('home') }, 'На главную')
    );
  }

  const SCREENS = {
    loading: screenLoading,
    error: screenError,
    home: screenHome,
    services: screenServices,
    datetime: screenDatetime,
    contacts: screenContacts,
    confirm: screenConfirm,
    success: screenSuccess,
  };

  // ---------- действия ----------

  async function startBooking() {
    mainButton.progress(true);
    try {
      state.services = await api('api/services');
      const before = state.selected.length;
      state.selected = state.selected.filter((id) => state.services.some((s) => s.id === id));
      if (state.selected.length !== before) resetDateTime();
      go('services');
    } catch (e) {
      alertBox(e.message);
    } finally {
      mainButton.progress(false);
    }
  }

  function toggleService(id) {
    haptic.select();
    state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id];
    // Длительность изменилась — свободные окна нужно пересчитать
    resetDateTime();
    render();
  }

  async function loadCalendar(month, initial) {
    const request = ++calendarRequest;
    state.month = month;
    state.calendarLoading = true;
    render();
    try {
      const data = await api(`api/calendar?month=${month}&services=${state.selected.join(',')}`);
      if (request !== calendarRequest) return;
      const available = Object.keys(data.days).sort();
      // Первый вход в конце месяца: свободных дней нет — сразу показываем следующий
      if (initial && !available.length && month < data.max_month) {
        state.calendarLoading = false;
        return loadCalendar(fmt.shiftMonth(month, 1), false);
      }
      state.calendar = data;
      state.calendarLoading = false;
      if (!state.date || !data.days[state.date]) {
        if (available.length) return selectDate(available[0]);
        state.date = null;
        state.slots = null;
        state.time = null;
      }
      render();
    } catch (e) {
      if (request !== calendarRequest) return;
      state.calendarLoading = false;
      render();
      toast(e.message);
    }
  }

  async function selectDate(iso) {
    const request = ++slotsRequest;
    state.date = iso;
    state.time = null;
    state.slots = null;
    state.slotsLoading = true;
    render();
    try {
      const data = await api(`api/slots?date=${iso}&services=${state.selected.join(',')}`);
      if (request !== slotsRequest) return;
      state.slots = data.slots;
    } catch (e) {
      if (request !== slotsRequest) return;
      state.slots = [];
      toast(e.message);
    }
    state.slotsLoading = false;
    render();
  }

  function showContactsError(message) {
    const el = document.getElementById('contacts-error');
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  function phoneLooksValid(phone) {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }

  function submitContacts() {
    const name = state.name.trim();
    if (name.length < 2) {
      haptic.error();
      showContactsError('Укажите, пожалуйста, имя');
      document.getElementById('name').focus();
      return;
    }
    if (!phoneLooksValid(state.phone)) {
      haptic.error();
      showContactsError('Укажите номер телефона полностью, например +7 999 123-45-67');
      document.getElementById('phone').focus();
      return;
    }
    if (document.activeElement) document.activeElement.blur();
    go('confirm');
  }

  function applyPhone(phone) {
    state.phone = phone.startsWith('+') ? phone : '+' + phone;
    const input = document.getElementById('phone');
    if (input) input.value = state.phone;
    showContactsError('');
    haptic.success();
  }

  function requestPhone() {
    tg.requestContact((shared, response) => {
      if (!shared) return;
      let phone = '';
      try {
        const contact = response && response.responseUnsafe && response.responseUnsafe.contact;
        const parsed = typeof contact === 'string' ? JSON.parse(contact) : contact;
        phone = (parsed && parsed.phone_number) || '';
      } catch (e) {
        /* формат ответа отличается — возьмём номер, который бот сохранил из сообщения */
      }
      if (phone) return applyPhone(phone);
      setTimeout(async () => {
        try {
          const me = await api('api/me');
          if (me.phone) applyPhone(me.phone);
        } catch (e) {
          /* не страшно — номер можно ввести вручную */
        }
      }, 1500);
    });
  }

  function requestWriteAccess() {
    // Боту нужно право писать клиенту, чтобы прислать подтверждение
    const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (!user || user.allows_write_to_pm !== false || !versionAtLeast('6.9')) return Promise.resolve();
    return new Promise((resolve) => tg.requestWriteAccess(() => resolve()));
  }

  async function submitBooking() {
    if (state.submitting) return;
    state.submitting = true;
    mainButton.progress(true);
    try {
      await requestWriteAccess();
      const booking = await api('api/bookings', {
        method: 'POST',
        body: {
          service_ids: state.selected,
          date: state.date,
          time: state.time,
          client_name: state.name.trim(),
          phone: state.phone.trim(),
        },
      });
      haptic.success();
      state.lastBooking = booking;
      state.phone = booking.phone;
      state.selected = [];
      resetDateTime();
      state.bookings = await api('api/bookings/my').catch(() => [...state.bookings, booking]);
      reset('success');
    } catch (e) {
      haptic.error();
      await alertBox(e.message);
      if (e.status === 409) {
        // Слот успели занять — возвращаемся к выбору времени со свежим расписанием
        const date = state.date;
        resetDateTime();
        history.splice(0, history.length, 'home', 'services');
        state.screen = 'datetime';
        state.month = date.slice(0, 7);
        onEnter('datetime');
        render(true);
      }
    } finally {
      state.submitting = false;
      mainButton.progress(false);
    }
  }

  async function cancelBooking(booking) {
    const ok = await confirmBox(`Отменить запись на ${fmt.date(booking.date)}, ${booking.time}?`);
    if (!ok) return;
    try {
      await api(`api/bookings/${booking.id}/cancel`, { method: 'POST' });
      haptic.success();
      state.bookings = state.bookings.filter((b) => b.id !== booking.id);
      render();
      toast('Запись отменена, мастер получит уведомление');
    } catch (e) {
      alertBox(e.message);
    }
  }

  async function boot() {
    state.screen = 'loading';
    render();
    try {
      const [me, services, bookings] = await Promise.all([api('api/me'), api('api/services'), api('api/bookings/my')]);
      window.App.currency = me.currency;
      document.title = me.salon_name;
      state.me = me;
      state.services = services;
      state.bookings = bookings;
      state.name = state.name || me.name || '';
      state.phone = state.phone || me.phone || '';
      reset('home');
    } catch (e) {
      state.error = e.message;
      reset('error');
    }
  }

  window.App.init();
  boot();
})();
