(() => {
  const { Dogs, Entries, Photos, Weights } = window.DB;
  const H = window.Helpers;

  // ---- In-memory state ----
  let dogs = [];
  let currentDogId = localStorage.getItem('pawbook_currentDogId') || null;
  let activeTab = 'timeline';
  let pendingPhotos = []; // [{thumbBlob, fullBlob, previewUrl}] for the entry sheet in progress
  let pendingEntryLocation = null; // {lat, lon} picked up from EXIF, for the single-entry add flow
  let entryDateManuallyEdited = false; // true once the user types in #entryDate themselves
  let editingDogId = null; // set when the dog sheet is in "edit" mode
  let pendingDogPhoto = null; // {thumbBlob, fullBlob, previewUrl} — newly picked avatar, not yet saved
  let dogPhotoRemoved = false; // true when editing and the user cleared the existing avatar
  let timelineQuery = '';
  let timelineTypeFilter = 'all';
  let searchAllDogs = false;
  let recapDogId = null; // which dog the open recap sheet is showing
  let bulkImportGroups = []; // [{date, photoIds: [], previewUrls: [], location, skipped}] during a bulk import review
  let editingEntryId = null; // set when the entry sheet is in "edit" mode
  let editingEntryOriginal = null; // the full original entry record being edited, for merging on save
  let removedExistingPhotoIds = []; // existing photos removed while editing, cleaned up from storage on save
  let photoViewerContext = { photoIds: [], index: 0 };
  let pendingVaccineSchedule = []; // [{label, dueDate, skipped}] while reviewing the suggested schedule

  // Session-lived cache of photoId -> full-resolution object URL, for the
  // full-screen photo viewer (separate from photoUrlCache, which holds thumbs).
  const fullUrlCache = new Map();
  // id -> entry record, refreshed whenever entries are fetched for rendering.
  // Lets click handlers (favorite, edit, photo viewer) look an entry up
  // without needing the whole entries array threaded through every call.
  const entryLookupById = new Map();

  // Session-lived cache of photoId -> thumbnail object URL, so repeated
  // renders (dog switcher, timeline, profile) don't keep creating fresh
  // object URLs for the same underlying blob.
  const photoUrlCache = new Map();

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const dogSwitcherEl = $('#dogSwitcher');
  const screens = {
    timeline: $('#screen-timeline'),
    weight: $('#screen-weight'),
    stats: $('#screen-stats'),
    profile: $('#screen-profile'),
    backup: $('#screen-backup'),
  };
  const tabBtns = $$('.tab-btn');
  const fab = $('#fab');
  const toastEl = $('#toast');

  // ================= Utilities =================

  function showToast(msg, action) {
    toastEl.innerHTML = '';
    toastEl.appendChild(document.createTextNode(msg));
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        toastEl.classList.remove('show');
        clearTimeout(showToast._t);
        action.onClick();
      });
      toastEl.appendChild(btn);
    }
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), action ? 4000 : 1800);
  }

  function openSheet(sheetEl) {
    $('#sheetBackdrop').classList.add('open');
    sheetEl.classList.add('open');
  }

  function closeSheet(sheetEl) {
    sheetEl.classList.remove('open');
    if (!$$('.sheet.open').length) $('#sheetBackdrop').classList.remove('open');
  }

  function closeAllSheets() {
    if ($('#bulkImportSheet').classList.contains('open')) {
      cancelBulkImport();
      return;
    }
    $$('.sheet').forEach(closeSheet);
  }

  function currentDog() {
    return dogs.find((d) => d.id === currentDogId) || null;
  }

  function objectUrlFor(blob) {
    return blob ? URL.createObjectURL(blob) : '';
  }

  async function getPhotoThumbUrl(photoId) {
    if (!photoId) return '';
    if (photoUrlCache.has(photoId)) return photoUrlCache.get(photoId);
    const rec = await Photos.get(photoId).catch(() => null);
    const url = rec && rec.thumbBlob ? objectUrlFor(rec.thumbBlob) : '';
    photoUrlCache.set(photoId, url);
    return url;
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function emptyStateHtml(paw, title, body) {
    return `<div class="empty-state"><div class="paw">${paw}</div><h2>${title}</h2><p>${body}</p></div>`;
  }

  // ================= Boot =================

  async function boot() {
    dogs = await Dogs.all();

    if (!dogs.length) {
      showOnboarding();
      return;
    }

    if (!currentDogId || !dogs.some((d) => d.id === currentDogId)) {
      currentDogId = dogs[0].id;
    }
    persistCurrentDog();

    await renderDogSwitcher();
    setTab('timeline');
    wireEvents();
    purgeExpiredTrash();
  }

  function persistCurrentDog() {
    if (currentDogId) localStorage.setItem('pawbook_currentDogId', currentDogId);
  }

  function showOnboarding() {
    wireEvents();
    editingDogId = null;
    $('#dogSheetTitle').textContent = 'Add your first dog';
    $('#dogSheetDelete').style.display = 'none';
    resetDogForm();
    openSheet($('#dogSheet'));
  }

  // ================= Tabs =================

  function setTab(tab) {
    activeTab = tab;
    Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === tab));
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    fab.style.display = tab === 'timeline' ? 'flex' : 'none';
    render();
  }

  // ================= Dog switcher =================

  async function renderDogSwitcher() {
    dogSwitcherEl.innerHTML = '';
    for (const dog of dogs) {
      const avatarUrl = await getPhotoThumbUrl(dog.coverPhotoId);
      const chip = document.createElement('button');
      chip.className = 'dog-chip' + (dog.id === currentDogId ? ' active' : '');
      chip.innerHTML = `<span class="avatar">${avatarUrl ? `<img src="${avatarUrl}" alt="">` : initials(dog.name)}</span>${escapeHtml(dog.name)}`;
      chip.addEventListener('click', () => {
        currentDogId = dog.id;
        persistCurrentDog();
        renderDogSwitcher();
        render();
      });
      dogSwitcherEl.appendChild(chip);
    }

    const addChip = document.createElement('button');
    addChip.className = 'dog-chip add';
    addChip.textContent = '+ Add dog';
    addChip.addEventListener('click', () => {
      editingDogId = null;
      $('#dogSheetTitle').textContent = 'Add a dog';
      $('#dogSheetDelete').style.display = 'none';
      resetDogForm();
      openSheet($('#dogSheet'));
    });
    dogSwitcherEl.appendChild(addChip);

    $('#allDogsToggle').classList.toggle('hidden', dogs.length <= 1);
  }

  // ================= Render dispatch =================

  async function render() {
    if (activeTab === 'backup') {
      renderBackupScreen();
      return;
    }
    if (!currentDog()) return;
    if (activeTab === 'timeline') await renderTimeline();
    if (activeTab === 'weight') await renderWeight();
    if (activeTab === 'stats') await renderStats();
    if (activeTab === 'profile') await renderProfile();
  }

  // ================= Timeline =================

  const TYPE_META = {
    photo: { icon: '📷', label: 'Photo' },
    note: { icon: '📝', label: 'Note' },
    milestone: { icon: '⭐', label: 'Milestone' },
    walk: { icon: '🐾', label: 'Walk' },
    vet: { icon: '🩺', label: 'Vet visit' },
    vaccination: { icon: '💉', label: 'Vaccination' },
  };

  async function renderTimeline() {
    const content = $('#timelineContent');
    const dogEntries = await Entries.forDog(currentDogId);
    const searchSourceEntries = searchAllDogs ? await Entries.all() : dogEntries;

    if (!dogEntries.length && !searchAllDogs) {
      content.innerHTML = emptyStateHtml('🐾', 'No entries yet', 'Tap the + button to add your first photo or memory.');
      return;
    }

    const today = H.todayLocalStr();
    let html = '';

    // Care reminders and "on this day" always stay scoped to the currently
    // selected dog, regardless of the all-dogs search toggle — they're
    // context for "this dog", not part of the search results themselves.
    const reminders = H.upcomingCareReminders(dogEntries, today, 30);
    if (reminders.length) {
      const overdue = reminders.filter((r) => r.daysUntil < 0);
      const cls = overdue.length ? 'overdue' : 'soon';
      const items = reminders
        .slice(0, 4)
        .map((r) => {
          const label = r.entry.caption || 'Vaccination';
          const when =
            r.daysUntil < 0
              ? `${Math.abs(r.daysUntil)} day${Math.abs(r.daysUntil) === 1 ? '' : 's'} overdue`
              : r.daysUntil === 0
              ? 'due today'
              : `due in ${r.daysUntil} day${r.daysUntil === 1 ? '' : 's'}`;
          return `<li>${escapeHtml(label)} — ${when}</li>`;
        })
        .join('');
      html += `<div class="care-banner ${cls}">
        <div class="label">${overdue.length ? 'Overdue' : 'Due soon'}</div>
        <ul>${items}</ul>
      </div>`;
    }

    const filtered = H.filterEntries(searchSourceEntries, { query: timelineQuery, type: timelineTypeFilter });

    if (!searchAllDogs) {
      const onThisDay = H.onThisDayEntries(dogEntries, today);
      if (onThisDay.length) {
        const years = onThisDay.map((e) => H.parseLocalDate(e.date).getFullYear()).join(', ');
        html += `<div class="on-this-day"><div>
            <div class="label">On this day</div>
            <div class="text">${onThisDay.length} ${onThisDay.length === 1 ? 'memory' : 'memories'} from ${years}</div>
          </div></div>`;
      }
    }

    if (!filtered.length) {
      html += emptyStateHtml('🔍', 'No matches', 'Try a different search or filter.');
      content.innerHTML = html;
      return;
    }

    const groups = H.groupEntriesByMonth(filtered);
    for (const group of groups) {
      html += `<div class="month-heading">${group.label}</div>`;
      for (const entry of group.entries) {
        const dogName = searchAllDogs ? (dogs.find((d) => d.id === entry.dogId) || {}).name : null;
        html += await entryCardHtml(entry, today, dogName);
      }
    }

    content.innerHTML = html;
    searchSourceEntries.forEach((e) => entryLookupById.set(e.id, e));
    wireEntryCardInteractions(content);
  }

  function entrySubtitleHtml(entry, today) {
    if (entry.type === 'walk') {
      const parts = [];
      if (entry.distanceKm) parts.push(`${entry.distanceKm} km`);
      if (entry.durationMin) parts.push(`${entry.durationMin} min`);
      return parts.length ? `<p class="caption"><strong>${parts.join(' · ')}</strong></p>` : '';
    }
    if (entry.type === 'vaccination' && entry.nextDueDate) {
      const days = H.daysUntil(entry.nextDueDate, today);
      const overdue = days < 0;
      const when = overdue
        ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
        : `next due ${H.formatDateLong(entry.nextDueDate)}`;
      return `<p class="caption"><strong style="color:${overdue ? 'var(--rust)' : 'var(--ink)'}">${when}</strong></p>`;
    }
    return '';
  }

  async function entryCardHtml(entry, today, dogName) {
    const photoRecords = await Promise.all((entry.photoIds || []).map((id) => Photos.get(id).catch(() => null)));
    const validPhotos = photoRecords.filter(Boolean);

    let photosHtml = '';
    if (validPhotos.length) {
      const n = validPhotos.length === 1 ? 'n1' : validPhotos.length === 2 ? 'n2' : 'nmany';
      const extraCount = validPhotos.length - 4;
      photosHtml = `<div class="entry-photos ${n}" data-photo-ids='${JSON.stringify(entry.photoIds || [])}'>${validPhotos
        .slice(0, 4)
        .map((p, i) => {
          const badge = p.mediaType === 'video' ? '<span class="play-badge">▶</span>' : '';
          const moreBadge = i === 3 && extraCount > 0 ? `<span class="more-badge">+${extraCount}</span>` : '';
          return `<div class="photo-thumb-wrap" data-index="${i}"><img src="${objectUrlFor(p.thumbBlob)}" alt="">${badge}${moreBadge}</div>`;
        })
        .join('')}</div>`;
    }

    const tagsHtml =
      entry.tags && entry.tags.length
        ? `<div class="tags">${entry.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';

    const meta = TYPE_META[entry.type] || TYPE_META.note;
    const isOverdueVaccination =
      entry.type === 'vaccination' && entry.nextDueDate && H.daysUntil(entry.nextDueDate, today) < 0;

    const locationHtml = entry.location
      ? `<a class="loc-badge" href="https://www.google.com/maps?q=${entry.location.lat},${entry.location.lon}" target="_blank" rel="noopener">📍</a>`
      : '';

    const cardClasses = [
      'entry-card',
      entry.type === 'milestone' ? 'milestone' : '',
      entry.type === 'walk' ? 'walk' : '',
      entry.type === 'vet' ? 'vet' : '',
      entry.type === 'vaccination' ? 'vaccination' : '',
      isOverdueVaccination ? 'overdue' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `
      <div class="${cardClasses}" data-id="${entry.id}">
        <div class="date-stamp">${H.formatDateShort(entry.date)} · ${meta.icon} ${meta.label}${dogName ? ` · 🐕 ${escapeHtml(dogName)}` : ''}</div>
        ${photosHtml}
        <div class="entry-body">
          ${entrySubtitleHtml(entry, today)}
          ${entry.caption ? `<p class="caption">${escapeHtml(entry.caption)}</p>` : ''}
          <div class="meta">
            <span>${H.formatDateLong(entry.date)} ${locationHtml}</span>
            <button class="fav-btn ${entry.favorite ? 'active' : ''}" data-id="${entry.id}">${entry.favorite ? '♥' : '♡'}</button>
          </div>
          ${tagsHtml}
        </div>
      </div>`;
  }

  // Wires favoriting, tap-a-photo-to-view-fullscreen, and tap-the-card-to-edit
  // for every .entry-card within a freshly-rendered container. Called after
  // any innerHTML assignment that includes entry cards (timeline, health,
  // milestones) — entries must already be registered in entryLookupById.
  function wireEntryCardInteractions(containerEl) {
    containerEl.querySelectorAll('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entry = entryLookupById.get(btn.dataset.id);
        if (!entry) return;
        entry.favorite = !entry.favorite;
        await Entries.update(entry);
        btn.classList.toggle('active', entry.favorite);
        btn.textContent = entry.favorite ? '♥' : '♡';
      });
    });

    containerEl.querySelectorAll('.loc-badge').forEach((a) => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });

    containerEl.querySelectorAll('.entry-photos .photo-thumb-wrap').forEach((thumbEl) => {
      thumbEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = thumbEl.closest('.entry-photos');
        const photoIds = JSON.parse(wrap.dataset.photoIds || '[]');
        const index = Number(thumbEl.dataset.index || 0);
        openPhotoViewer(photoIds, index);
      });
    });

    containerEl.querySelectorAll('.entry-card').forEach((card) => {
      card.addEventListener('click', () => {
        const entry = entryLookupById.get(card.dataset.id);
        if (entry) openEntryEditor(entry);
      });
    });
  }

  // ================= Weight =================

  async function renderWeight() {
    const root = $('#screen-weight');
    const dog = currentDog();
    const weights = await Weights.forDog(currentDogId);

    if (!weights.length) {
      root.innerHTML =
        emptyStateHtml('⚖️', 'No weigh-ins yet', 'Log a weight to start tracking trends over time.') +
        `<button class="btn btn-primary btn-block" id="addFirstWeight">Log a weight</button>`;
      $('#addFirstWeight').addEventListener('click', () => openWeightSheet());
      return;
    }

    const latest = weights[weights.length - 1];
    const prev = weights.length > 1 ? weights[weights.length - 2] : null;
    const delta = prev ? latest.weightKg - prev.weightKg : null;
    const all = weights.map((w) => w.weightKg);
    const min = Math.min(...all);
    const max = Math.max(...all);

    const hasTarget = dog && typeof dog.targetMinKg === 'number' && typeof dog.targetMaxKg === 'number';
    const targetRange = hasTarget ? { min: dog.targetMinKg, max: dog.targetMaxKg } : null;
    const chart = H.buildWeightChartPoints(weights, 320, 140, 24, targetRange);
    const status = hasTarget ? H.weightStatus(latest.weightKg, dog.targetMinKg, dog.targetMaxKg) : null;

    let svg = '';
    if (chart) {
      const bandHtml = chart.targetBand
        ? `<rect x="24" y="${chart.targetBand.topY}" width="272" height="${Math.max(1, chart.targetBand.bottomY - chart.targetBand.topY)}" fill="var(--moss)" opacity="0.15" />`
        : '';
      svg = `<svg viewBox="0 0 320 140">
        ${bandHtml}
        <path class="chart-line" d="${chart.path}" />
        ${chart.points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="3.5" />`).join('')}
        <text class="chart-axis-label" x="24" y="134">${H.formatDateShort(weights[0].date)}</text>
        <text class="chart-axis-label" x="296" y="134" text-anchor="end">${H.formatDateShort(weights[weights.length - 1].date)}</text>
      </svg>`;
    }

    const statusLabels = {
      within: { text: '✓ Within target range', color: 'var(--moss)' },
      below: { text: '↓ Below target range', color: 'var(--gold)' },
      above: { text: '↑ Above target range', color: 'var(--rust)' },
    };
    const statusHtml = status
      ? `<div style="text-align:center; font-size:13px; font-weight:600; color:${statusLabels[status].color}; margin:-8px 0 12px;">${statusLabels[status].text} (${dog.targetMinKg}–${dog.targetMaxKg} kg)</div>`
      : '';

    root.innerHTML = `
      <div class="weight-summary">
        <div class="stat-card">
          <div class="value">${latest.weightKg.toFixed(1)}<span style="font-size:13px">kg</span></div>
          <div class="label">Current</div>
          ${delta !== null ? `<div class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg</div>` : ''}
        </div>
        <div class="stat-card">
          <div class="value">${min.toFixed(1)}–${max.toFixed(1)}</div>
          <div class="label">Range (kg)</div>
        </div>
      </div>
      ${statusHtml}
      <div class="chart-card">${svg}</div>
      <button class="btn btn-primary btn-block" id="addWeightBtn" style="margin-bottom:16px;">+ Log weight</button>
      <div id="weightList"></div>
    `;

    const listEl = $('#weightList');
    [...weights].reverse().forEach((w) => {
      const row = document.createElement('div');
      row.className = 'weight-row';
      row.innerHTML = `
        <div>
          <div class="w-date">${H.formatDateLong(w.date)}</div>
          ${w.note ? `<div class="w-note">${escapeHtml(w.note)}</div>` : ''}
        </div>
        <div class="w-val">${w.weightKg.toFixed(1)} kg <span style="color:var(--ink-soft);font-weight:400;">(${H.kgToLb(w.weightKg).toFixed(1)} lb)</span></div>
      `;
      listEl.appendChild(row);
    });

    $('#addWeightBtn').addEventListener('click', () => openWeightSheet());
  }

  function openWeightSheet() {
    $('#weightDate').value = H.todayLocalStr();
    $('#weightKg').value = '';
    $('#weightNote').value = '';
    openSheet($('#weightSheet'));
  }

  // ================= Profile =================

  async function renderProfile() {
    const root = $('#screen-profile');
    const dog = currentDog();
    if (!dog) return;

    const entries = await Entries.forDog(currentDogId);
    entries.forEach((e) => entryLookupById.set(e.id, e));
    const milestones = entries.filter((e) => e.type === 'milestone' || e.favorite);
    const healthEntries = entries.filter((e) => e.type === 'vet' || e.type === 'vaccination');
    const age = dog.birthday ? H.calcAge(dog.birthday) : null;
    const avatarUrl = await getPhotoThumbUrl(dog.coverPhotoId);
    const tags = H.getAllTags(entries);

    const today = H.todayLocalStr();
    const weekAgo = (() => {
      const d = H.parseLocalDate(today);
      d.setDate(d.getDate() - 7);
      return H.todayLocalStr(d);
    })();
    const allTimeWalks = H.walkStats(entries);
    const weekWalks = H.walkStats(entries, weekAgo);

    let healthHtml = '';
    if (healthEntries.length) {
      healthHtml = `<div class="month-heading">Health</div>`;
      for (const entry of healthEntries) {
        healthHtml += await entryCardHtml(entry, today);
      }
    }

    let milestonesHtml = '';
    if (milestones.length) {
      milestonesHtml = `<div class="month-heading">Milestones &amp; favorites</div>`;
      for (const entry of milestones) {
        milestonesHtml += await entryCardHtml(entry, today);
      }
    }

    const tagsHtml = tags.length
      ? `<div class="month-heading">Tags</div>
         <div style="margin-bottom:6px;">${tags
           .map((t) => `<button type="button" class="tag-browse-chip" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)} <span class="count">${t.count}</span></button>`)
           .join('')}</div>`
      : '';

    // Offer the puppy vaccination schedule suggestion only while it's
    // actually relevant — roughly the first two years.
    const showVaccineSuggestion = age && age.years < 2 && dog.birthday;

    root.innerHTML = `
      <div class="dog-hero">
        <div class="avatar-lg">${avatarUrl ? `<img src="${avatarUrl}" alt="">` : initials(dog.name)}</div>
        <h2>${escapeHtml(dog.name)}</h2>
        <div class="sub">${[dog.breed, age ? H.formatAge(age) : null].filter(Boolean).join(' · ') || 'Add breed & birthday'}</div>
      </div>
      <div class="profile-actions">
        <button class="btn btn-secondary" style="flex:1" id="editDogBtn">Edit profile</button>
        <button class="btn btn-secondary" style="flex:1" id="recapBtn">Year in review</button>
      </div>

      <div class="recap-grid" style="margin-top:18px;">
        <div class="stat-card">
          <div class="value">${weekWalks.count}</div>
          <div class="label">Walks this week</div>
          <div class="delta" style="color:var(--ink-soft)">${weekWalks.totalKm.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
          <div class="value">${allTimeWalks.count}</div>
          <div class="label">Walks all-time</div>
          <div class="delta" style="color:var(--ink-soft)">${allTimeWalks.totalKm.toFixed(1)} km total</div>
        </div>
      </div>

      ${showVaccineSuggestion ? `<button class="btn btn-secondary btn-block" id="suggestVaccineBtn" style="margin-top:14px;">💉 Suggest vaccination schedule</button>` : ''}

      ${tagsHtml}
      ${healthHtml}
      ${milestonesHtml}
    `;

    wireEntryCardInteractions(root);

    $('#editDogBtn').addEventListener('click', () => {
      editingDogId = dog.id;
      $('#dogSheetTitle').textContent = 'Edit profile';
      $('#dogSheetDelete').style.display = dogs.length > 1 ? 'block' : 'none';
      $('#dogName').value = dog.name || '';
      $('#dogBreed').value = dog.breed || '';
      $('#dogBirthday').value = dog.birthday || '';
      $('#dogTargetMinKg').value = dog.targetMinKg || '';
      $('#dogTargetMaxKg').value = dog.targetMaxKg || '';
      pendingDogPhoto = null;
      dogPhotoRemoved = false;
      renderDogAvatarPicker(avatarUrl);
      openSheet($('#dogSheet'));
    });

    $('#recapBtn').addEventListener('click', () => openRecapSheet(dog.id));

    $$('.tag-browse-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        timelineQuery = chip.dataset.tag;
        timelineTypeFilter = 'all';
        searchAllDogs = false;
        $('#timelineSearch').value = chip.dataset.tag;
        $('#allDogsToggle').classList.remove('active');
        $$('.filter-chip').forEach((c) => c.classList.toggle('active', c.dataset.type === 'all'));
        setTab('timeline');
      });
    });

    const suggestBtn = $('#suggestVaccineBtn');
    if (suggestBtn) suggestBtn.addEventListener('click', () => openVaccineScheduleSheet(dog));
  }

  // ================= Year in review =================

  async function openRecapSheet(dogId) {
    recapDogId = dogId;
    const entries = await Entries.forDog(dogId);
    const weights = await Weights.forDog(dogId);
    const years = H.yearsWithData(entries, weights, H.todayLocalStr());

    const select = $('#recapYearSelect');
    select.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    select.value = String(years[0]);

    renderRecapContent(entries, weights, years[0]);
    openSheet($('#recapSheet'));
  }

  function renderRecapContent(entries, weights, year) {
    const recap = H.buildYearRecap(entries, weights, year);
    const content = $('#recapContent');

    if (!recap.totalEntries && !recap.weight.first) {
      content.innerHTML = emptyStateHtml('📅', 'Nothing logged', `No entries or weigh-ins found for ${year}.`);
      return;
    }

    const weightHtml = recap.weight.first
      ? `<div class="recap-section">
          <h4>Weight</h4>
          <p style="font-size:14px;">
            ${recap.weight.first.weightKg.toFixed(1)} kg → ${recap.weight.last.weightKg.toFixed(1)} kg
            ${recap.weight.change !== null ? `<strong style="color:${recap.weight.change > 0 ? 'var(--rust)' : 'var(--moss)'}">(${recap.weight.change > 0 ? '+' : ''}${recap.weight.change.toFixed(1)} kg)</strong>` : ''}
          </p>
        </div>`
      : '';

    const typeBreakdown = Object.entries(recap.byType)
      .map(([type, count]) => `<li>${(TYPE_META[type] || {}).icon || ''} ${count} ${(TYPE_META[type] || { label: type }).label.toLowerCase()}${count === 1 ? '' : 's'}</li>`)
      .join('');

    content.innerHTML = `
      <div class="recap-hero">
        <div class="big-num">${recap.totalEntries}</div>
        <div class="big-label">entries logged in ${year}</div>
      </div>
      <div class="recap-grid">
        <div class="stat-card">
          <div class="value">${recap.walks.count}</div>
          <div class="label">Walks</div>
          <div class="delta" style="color:var(--ink-soft)">${recap.walks.totalKm.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
          <div class="value">${recap.favorites.length}</div>
          <div class="label">Favorites</div>
        </div>
      </div>
      ${weightHtml}
      <div class="recap-section">
        <h4>By type</h4>
        ${typeBreakdown ? `<ul style="padding-left:18px; font-size:14px; margin:0;">${typeBreakdown}</ul>` : `<p class="empty-note">Nothing logged.</p>`}
      </div>
      ${recap.milestones.length ? `<div class="recap-section"><h4>Milestones (${recap.milestones.length})</h4><p style="font-size:14px;">${recap.milestones.map((m) => escapeHtml(m.caption || 'Milestone')).join(' · ')}</p></div>` : ''}
    `;
  }

  // ================= Dog sheet (add/edit) =================

  function resetDogForm() {
    $('#dogName').value = '';
    $('#dogBreed').value = '';
    $('#dogBirthday').value = '';
    $('#dogTargetMinKg').value = '';
    $('#dogTargetMaxKg').value = '';
    pendingDogPhoto = null;
    dogPhotoRemoved = false;
    renderDogAvatarPicker('');
  }

  function renderDogAvatarPicker(existingUrl) {
    const wrap = $('#dogAvatarPicker');
    wrap.innerHTML = '';

    const showUrl = pendingDogPhoto ? pendingDogPhoto.previewUrl : dogPhotoRemoved ? '' : existingUrl;

    if (showUrl) {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.innerHTML = `<img src="${showUrl}" alt=""><button class="remove" type="button">×</button>`;
      thumb.querySelector('.remove').addEventListener('click', () => {
        if (pendingDogPhoto) {
          URL.revokeObjectURL(pendingDogPhoto.previewUrl);
          pendingDogPhoto = null;
        }
        dogPhotoRemoved = true;
        renderDogAvatarPicker(existingUrl);
      });
      wrap.appendChild(thumb);
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'add-photo';
      addBtn.type = 'button';
      addBtn.textContent = '+';
      // iOS requires the file input open synchronously within the tap handler.
      addBtn.addEventListener('click', () => $('#dogPhotoInput').click());
      wrap.appendChild(addBtn);
    }
  }

  async function handleDogPhotoSelection(fileList) {
    const file = (fileList || [])[0];
    if (!file) return;
    if (!looksLikeImageFile(file)) {
      showToast("Couldn't read that photo");
      return;
    }
    showToast('Processing photo…');
    try {
      const { thumbBlob, fullBlob } = await window.Media.processPhoto(file);
      if (pendingDogPhoto) URL.revokeObjectURL(pendingDogPhoto.previewUrl);
      pendingDogPhoto = { thumbBlob, fullBlob, previewUrl: objectUrlFor(thumbBlob) };
      dogPhotoRemoved = false;
    } catch (err) {
      console.error('Dog photo processing failed', err);
      showToast(describeError(err));
      return;
    }
    renderDogAvatarPicker('');
  }

  async function saveDog() {
    const name = $('#dogName').value.trim();
    if (!name) {
      showToast('Give your dog a name first');
      return;
    }
    const breed = $('#dogBreed').value.trim();
    const birthday = $('#dogBirthday').value || null;
    const targetMinKg = parseFloat($('#dogTargetMinKg').value) || null;
    const targetMaxKg = parseFloat($('#dogTargetMaxKg').value) || null;
    if (targetMinKg && targetMaxKg && targetMinKg > targetMaxKg) {
      showToast('Target min should be less than target max');
      return;
    }

    let coverPhotoId;
    if (pendingDogPhoto) {
      const rec = await Photos.add({ thumbBlob: pendingDogPhoto.thumbBlob, fullBlob: pendingDogPhoto.fullBlob });
      coverPhotoId = rec.id;
    } else if (dogPhotoRemoved) {
      coverPhotoId = null;
    }

    if (editingDogId) {
      const dog = dogs.find((d) => d.id === editingDogId);
      dog.name = name;
      dog.breed = breed;
      dog.birthday = birthday;
      dog.targetMinKg = targetMinKg;
      dog.targetMaxKg = targetMaxKg;
      if (coverPhotoId !== undefined) {
        photoUrlCache.delete(dog.coverPhotoId);
        dog.coverPhotoId = coverPhotoId;
      }
      await Dogs.update(dog);
    } else {
      const dog = await Dogs.add({ name, breed, birthday, targetMinKg, targetMaxKg, coverPhotoId: coverPhotoId || null });
      dogs.push(dog);
      currentDogId = dog.id;
      persistCurrentDog();
    }

    closeSheet($('#dogSheet'));
    await renderDogSwitcher();
    setTab(activeTab === 'profile' || dogs.length === 1 ? 'timeline' : activeTab);
    showToast('Saved');
  }

  async function deleteDog() {
    if (!editingDogId) return;
    if (!confirm("Delete this dog and all their entries? This can't be undone.")) return;

    const entries = await Entries.forDog(editingDogId);
    for (const e of entries) await Entries.remove(e.id);
    const weights = await Weights.forDog(editingDogId);
    for (const w of weights) await Weights.remove(w.id);
    await Dogs.remove(editingDogId);

    dogs = dogs.filter((d) => d.id !== editingDogId);
    if (currentDogId === editingDogId) currentDogId = dogs.length ? dogs[0].id : null;
    persistCurrentDog();
    closeSheet($('#dogSheet'));

    if (!dogs.length) {
      showOnboarding();
    } else {
      await renderDogSwitcher();
      setTab('timeline');
    }
  }

  // ================= Entry sheet (add) =================

  function updateTypeOnlyFields(type) {
    $$('.type-only').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.forType !== type);
    });
    const label = $('#captionLabel');
    const placeholders = {
      photo: 'What happened?',
      note: 'What happened?',
      milestone: 'What happened?',
      walk: 'Any notes about the walk (optional)',
      vet: 'Reason for visit / notes',
      vaccination: 'Vaccine name / notes',
    };
    $('#entryCaption').placeholder = placeholders[type] || 'What happened?';
    label.textContent = type === 'vet' ? 'Reason / notes' : type === 'vaccination' ? 'Vaccine / notes' : 'Caption / note';
  }

  function resetEntryForm() {
    editingEntryId = null;
    editingEntryOriginal = null;
    removedExistingPhotoIds = [];
    $('#entrySheetTitle').textContent = 'New entry';
    $('#saveEntryBtn').textContent = 'Add to timeline';
    $('#entrySheetDelete').classList.add('hidden');

    $('#entryDate').value = H.todayLocalStr();
    $('#entryCaption').value = '';
    $('#entryTags').value = '';
    $('#walkDistanceKm').value = '';
    $('#walkDurationMin').value = '';
    $('#vaccineNextDue').value = '';
    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    pendingPhotos = [];
    pendingEntryLocation = null;
    entryDateManuallyEdited = false;
    renderPhotoPicker();
    $$('.type-toggle button').forEach((b) => b.classList.toggle('selected', b.dataset.type === 'photo'));
    $('#entrySheet').dataset.type = 'photo';
    updateTypeOnlyFields('photo');
  }

  // Opens the same sheet used for adding, pre-filled from an existing entry.
  async function openEntryEditor(entry) {
    editingEntryId = entry.id;
    editingEntryOriginal = entry;
    removedExistingPhotoIds = [];

    $('#entrySheetTitle').textContent = 'Edit entry';
    $('#saveEntryBtn').textContent = 'Save changes';
    $('#entrySheetDelete').classList.remove('hidden');

    $('#entryDate').value = entry.date;
    $('#entryCaption').value = entry.caption || '';
    $('#entryTags').value = (entry.tags || []).join(', ');
    $('#walkDistanceKm').value = entry.distanceKm || '';
    $('#walkDurationMin').value = entry.durationMin || '';
    $('#vaccineNextDue').value = entry.nextDueDate || '';
    pendingEntryLocation = entry.location || null;
    // The date is already meaningfully set from the saved entry — treat it
    // as "manually edited" so adding a new photo during this edit can't
    // silently overwrite a date the user is intentionally keeping.
    entryDateManuallyEdited = true;

    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    const existingPhotoRecords = await Promise.all((entry.photoIds || []).map((id) => Photos.get(id).catch(() => null)));
    pendingPhotos = existingPhotoRecords
      .filter(Boolean)
      .map((rec) => ({
        existingPhotoId: rec.id,
        thumbBlob: rec.thumbBlob,
        fullBlob: rec.fullBlob,
        videoBlob: rec.videoBlob,
        mediaType: rec.mediaType || 'photo',
        previewUrl: objectUrlFor(rec.thumbBlob),
      }));
    renderPhotoPicker();

    $$('.type-toggle button').forEach((b) => b.classList.toggle('selected', b.dataset.type === entry.type));
    $('#entrySheet').dataset.type = entry.type;
    updateTypeOnlyFields(entry.type);

    openSheet($('#entrySheet'));
  }

  async function deleteEntry() {
    if (!editingEntryId) return;
    const id = editingEntryId;

    await Entries.softDelete(id);
    const updated = await Entries.get(id);
    entryLookupById.set(id, updated);

    closeSheet($('#entrySheet'));
    if (activeTab === 'timeline') renderTimeline();
    else if (activeTab === 'profile') renderProfile();

    // Photos are only cleaned up when the entry is actually purged (either
    // manually from Recently Deleted, or automatically after 30 days) —
    // never at the moment of a soft delete, since Undo needs them intact.
    showToast('Entry moved to Recently Deleted', {
      label: 'Undo',
      onClick: async () => {
        await Entries.restore(id);
        const restored = await Entries.get(id);
        entryLookupById.set(id, restored);
        showToast('Restored');
        if (activeTab === 'timeline') renderTimeline();
        else if (activeTab === 'profile') renderProfile();
      },
    });
  }

  function renderPhotoPicker() {
    const wrap = $('#photoPicker');
    wrap.innerHTML = '';
    pendingPhotos.forEach((p, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const badge = p.mediaType === 'video' ? '<span class="play-badge">▶</span>' : '';
      thumb.innerHTML = `<img src="${p.previewUrl}" alt="">${badge}<button class="remove" data-i="${i}">×</button>`;
      wrap.appendChild(thumb);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'add-photo';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.id = 'addPhotoBtn';
    wrap.appendChild(addBtn);

    addBtn.addEventListener('click', () => $('#photoInput').click());

    $$('.thumb .remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const removed = pendingPhotos[i];
        // Only revoke/drop a brand-new (not-yet-saved) photo's preview URL
        // outright. An existing, already-stored photo needs its storage
        // record cleaned up too — tracked here and actually deleted on save,
        // so cancelling the edit entirely leaves the original untouched.
        if (removed.existingPhotoId) {
          removedExistingPhotoIds.push(removed.existingPhotoId);
        } else {
          URL.revokeObjectURL(removed.previewUrl);
        }
        pendingPhotos.splice(i, 1);
        renderPhotoPicker();
      });
    });
  }

  // EXIF reading is always best-effort and must never block a photo from
  // being saved — if anything about it fails, treat it exactly like a photo
  // that simply has no EXIF data.
  async function safeParseExif(file) {
    try {
      return await window.Exif.parseExifFromFile(file);
    } catch (err) {
      console.warn('EXIF read failed, continuing without it:', err);
      return { date: null, location: null };
    }
  }

  async function safeParseVideoDate(file) {
    try {
      return await window.VideoMeta.parseVideoCreationDate(file);
    } catch (err) {
      console.warn('Video date read failed, continuing without it:', err);
      return null;
    }
  }

  // Some photo pickers (notably iOS's limited-access picker, in some
  // versions/situations) hand back files with an empty `type` and a
  // filename that doesn't obviously look like media. Previously this
  // filtered such files out entirely — which, combined with the file
  // input's own `accept` attribute already constraining what the OS picker
  // shows in the first place, meant a whole multi-file selection could
  // silently vanish with zero feedback. Now: only reject a file when its
  // type is explicitly set to something that is NOT an image or video. An
  // unknown/empty type is given the benefit of the doubt and attempted —
  // if it genuinely isn't readable, Media's own diagnostic error handles
  // that case visibly instead of a silent no-op.
  function looksLikeImageFile(file) {
    if (file.type) return file.type.startsWith('image/');
    return true;
  }

  function looksLikeMediaFile(file) {
    if (file.type) return file.type.startsWith('image/') || file.type.startsWith('video/');
    return true;
  }

  function describeError(err) {
    if (err && err.stage) return `Couldn't process that file (${err.stage} failed: ${err.cause ? err.cause.message : 'unknown'})`;
    if (err && err.message) return `Couldn't process that file (${err.message})`;
    return "Couldn't process that file — try a different one";
  }

  // Single entry point for turning a picked File into stored media plus
  // whatever date/location we can read from it — used by both the
  // single-entry picker and bulk import, so the two flows can't drift apart
  // (see rigorous-app-building skill, section 2, on that exact bug class).
  async function captureMedia(file) {
    if (window.Media.isVideoFile(file)) {
      const { thumbBlob, videoBlob, mediaType } = await window.Media.processVideo(file);
      const date = await safeParseVideoDate(file);
      return { thumbBlob, videoBlob, mediaType, date, location: null };
    }
    const { thumbBlob, fullBlob, mediaType } = await window.Media.processPhoto(file);
    const exif = await safeParseExif(file);
    return { thumbBlob, fullBlob, mediaType, date: exif.date, location: exif.location };
  }

  async function handlePhotoSelection(fileList) {
    const rawCount = (fileList || []).length;
    const files = Array.from(fileList || []).filter(looksLikeMediaFile);
    if (!files.length) {
      if (rawCount > 0) showToast(`Couldn't read the selected file${rawCount === 1 ? '' : 's'}`);
      return;
    }
    showToast('Processing file' + (files.length > 1 ? 's' : '') + '…');
    for (const file of files) {
      try {
        const { thumbBlob, fullBlob, videoBlob, mediaType, date, location } = await captureMedia(file);
        const contentHash = await hashFileBytes(file).catch(() => null);
        pendingPhotos.push({ thumbBlob, fullBlob, videoBlob, mediaType, contentHash, previewUrl: objectUrlFor(thumbBlob) });

        // Auto-fill the date from the file's embedded date (EXIF for
        // photos, container metadata for videos), but only if the user
        // hasn't already typed a date themselves — never overwrite a manual edit.
        if (date && !entryDateManuallyEdited) {
          $('#entryDate').value = date;
        }
        // Take the first location we find across the picked photos (videos
        // don't carry location in this app — see captureMedia above).
        if (location && !pendingEntryLocation) {
          pendingEntryLocation = location;
        }
      } catch (err) {
        console.error('Media processing failed', err);
        showToast(describeError(err));
      }
    }
    renderPhotoPicker();
  }

  async function saveEntry() {
    const type = $('#entrySheet').dataset.type || 'photo';
    const date = $('#entryDate').value || H.todayLocalStr();
    const caption = $('#entryCaption').value.trim();
    const tags = $('#entryTags').value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const distanceKm = parseFloat($('#walkDistanceKm').value) || 0;
    const durationMin = parseFloat($('#walkDurationMin').value) || 0;
    const nextDueDate = $('#vaccineNextDue').value || null;

    if (type === 'photo' && !pendingPhotos.length && !caption) {
      showToast('Add a photo or a note first');
      return;
    }
    if ((type === 'note' || type === 'milestone' || type === 'vet') && !caption) {
      showToast('Write a note first');
      return;
    }
    if (type === 'walk' && !distanceKm && !durationMin) {
      showToast('Add a distance or duration');
      return;
    }
    if (type === 'vaccination' && !nextDueDate) {
      showToast('Set the next due date');
      return;
    }

    let photoIds = [];
    if (type === 'photo') {
      for (const p of pendingPhotos) {
        if (p.existingPhotoId) {
          photoIds.push(p.existingPhotoId);
        } else {
          const rec = await Photos.add({ thumbBlob: p.thumbBlob, fullBlob: p.fullBlob, videoBlob: p.videoBlob, mediaType: p.mediaType || 'photo', contentHash: p.contentHash || null });
          photoIds.push(rec.id);
        }
      }
    } else {
      // Type isn't (or is no longer) 'photo' — any previously-attached
      // existing photos are now orphaned and should be cleaned up.
      for (const p of pendingPhotos) {
        if (p.existingPhotoId) removedExistingPhotoIds.push(p.existingPhotoId);
      }
    }

    let savedEntry;
    if (editingEntryId) {
      savedEntry = {
        id: editingEntryOriginal.id,
        dogId: editingEntryOriginal.dogId,
        favorite: editingEntryOriginal.favorite,
        createdAt: editingEntryOriginal.createdAt,
        date,
        type,
        caption,
        photoIds,
        tags,
      };
      if (type === 'photo' && pendingEntryLocation) savedEntry.location = pendingEntryLocation;
      if (type === 'walk') {
        savedEntry.distanceKm = distanceKm || undefined;
        savedEntry.durationMin = durationMin || undefined;
      }
      if (type === 'vaccination') savedEntry.nextDueDate = nextDueDate;
      await Entries.update(savedEntry);
      entryLookupById.set(savedEntry.id, savedEntry);
    } else {
      const entry = { dogId: currentDogId, date, type, caption, photoIds, tags };
      if (type === 'photo' && pendingEntryLocation) entry.location = pendingEntryLocation;
      if (type === 'walk') {
        entry.distanceKm = distanceKm || undefined;
        entry.durationMin = durationMin || undefined;
      }
      if (type === 'vaccination') entry.nextDueDate = nextDueDate;
      savedEntry = await Entries.add(entry);
      entryLookupById.set(savedEntry.id, savedEntry);
    }

    for (const id of removedExistingPhotoIds) await Photos.remove(id);

    const wasEditing = !!editingEntryId;
    closeSheet($('#entrySheet'));
    showToast(wasEditing ? 'Entry updated' : 'Added to timeline');
    if (activeTab === 'timeline') renderTimeline();
    else if (activeTab === 'profile') renderProfile();
  }

  // ================= Bulk photo import =================

  function resetBulkImportSheet() {
    bulkImportGroups = [];
    $('#bulkImportBody').classList.remove('hidden');
    $('#bulkImportProgress').classList.add('hidden');
    $('#bulkImportProgress').textContent = '';
    $('#bulkImportGroups').innerHTML = '';
    $('#bulkImportConfirmWrap').classList.add('hidden');
  }

  // Cleans up every photo already saved to IndexedDB for groups that are
  // still pending (not yet imported), so an abandoned bulk import never
  // leaves orphaned photo blobs behind.
  async function cleanupPendingBulkPhotos() {
    for (const group of bulkImportGroups) {
      if (group.skipped) continue;
      for (const id of group.photoIds) await Photos.remove(id);
    }
    bulkImportGroups = [];
  }

  async function cancelBulkImport() {
    await cleanupPendingBulkPhotos();
    closeSheet($('#bulkImportSheet'));
  }

  // Hashes a file's actual bytes (not name/size/date) so the same photo or
  // video picked again — even under a different filename, or in a later
  // bulk import session — is reliably recognized as identical content.
  async function hashFileBytes(file) {
    const buf = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function handleBulkPhotoSelection(fileList) {
    const rawCount = (fileList || []).length;
    const files = Array.from(fileList || []).filter(looksLikeMediaFile);
    if (!files.length) {
      if (rawCount > 0) {
        showToast(`Couldn't read any of the ${rawCount} selected file${rawCount === 1 ? '' : 's'}`);
      }
      return;
    }

    $('#bulkImportBody').classList.add('hidden');
    const progress = $('#bulkImportProgress');
    progress.classList.remove('hidden');

    // Build the existing-content index once up front, rather than per file —
    // one query for the whole batch. Photos without a contentHash (added
    // before this feature existed) simply can't be matched against, which
    // is a fine, safe default: nothing gets incorrectly flagged as a dup.
    progress.textContent = 'Checking for duplicates…';
    const existingPhotos = await Photos.all();
    const knownHashes = new Set(existingPhotos.map((p) => p.contentHash).filter(Boolean));
    const seenThisBatch = new Set();

    // A flat list of processed media before grouping — processed one at a
    // time (not in parallel) to keep memory use bounded for large batches.
    const processed = [];
    const failures = [];
    let duplicateCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      progress.textContent = `Processing ${i + 1} of ${files.length}…`;
      try {
        const hash = await hashFileBytes(file);
        if (knownHashes.has(hash) || seenThisBatch.has(hash)) {
          duplicateCount++;
          continue; // skip entirely — no point resizing/reading further for a dup
        }
        seenThisBatch.add(hash);

        const { thumbBlob, fullBlob, videoBlob, mediaType, date, location } = await captureMedia(file);
        const rec = await Photos.add({ thumbBlob, fullBlob, videoBlob, mediaType, contentHash: hash });
        const finalDate = date || dateFromFileTimestamp(file);
        processed.push({ photoId: rec.id, date: finalDate, location, mediaType, previewUrl: objectUrlFor(thumbBlob) });
      } catch (err) {
        console.error('Bulk media processing failed for', file.name, err);
        failures.push(file.name || `file ${i + 1}`);
      }
    }

    progress.classList.add('hidden');

    const messages = [];
    if (duplicateCount) messages.push(`${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped`);
    if (failures.length) messages.push(`${failures.length} couldn't be read`);
    if (messages.length) showToast(messages.join(' · '));

    // Group by date.
    const byDate = new Map();
    for (const p of processed) {
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, photoIds: [], items: [], location: null, skipped: false });
      const group = byDate.get(p.date);
      group.photoIds.push(p.photoId);
      group.items.push({ url: p.previewUrl, mediaType: p.mediaType });
      if (!group.location && p.location) group.location = p.location;
    }

    bulkImportGroups = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    renderBulkImportGroups();
  }

  // Media without an embedded date (a photo with no EXIF, or a video whose
  // container metadata wasn't readable) falls back to the file's own
  // last-modified timestamp — usually close to capture date, and always
  // editable below before anything is actually imported.
  function dateFromFileTimestamp(file) {
    if (file.lastModified) return H.todayLocalStr(new Date(file.lastModified));
    return H.todayLocalStr();
  }

  function renderBulkImportGroups() {
    const wrap = $('#bulkImportGroups');
    wrap.innerHTML = '';

    if (!bulkImportGroups.length) {
      wrap.innerHTML = emptyStateHtml('📷', 'Nothing found', 'Try choosing files again.');
      $('#bulkImportConfirmWrap').classList.add('hidden');
      return;
    }

    bulkImportGroups.forEach((group, i) => {
      const row = document.createElement('div');
      row.className = 'import-group' + (group.skipped ? ' skipped' : '');

      const thumbsHtml =
        group.items
          .slice(0, 3)
          .map((item) => `<div class="photo-thumb-wrap" style="width:44px;height:44px;border-radius:8px;"><img src="${item.url}" alt="">${item.mediaType === 'video' ? '<span class="play-badge">▶</span>' : ''}</div>`)
          .join('') + (group.items.length > 3 ? `<div class="more">+${group.items.length - 3}</div>` : '');

      row.innerHTML = `
        <div class="row-top">
          <input type="date" value="${group.date}" ${group.skipped ? 'disabled' : ''}>
          <button type="button" class="skip-btn">${group.skipped ? 'Include' : 'Skip'}</button>
        </div>
        <div class="thumbs">${thumbsHtml}</div>
        <div style="font-size:12px; color:var(--ink-soft); margin-top:6px;">${group.photoIds.length} item${group.photoIds.length === 1 ? '' : 's'}${group.location ? ' · 📍 has location' : ''}</div>
      `;

      row.querySelector('input[type="date"]').addEventListener('change', (e) => {
        group.date = e.target.value || group.date;
      });
      row.querySelector('.skip-btn').addEventListener('click', () => {
        group.skipped = !group.skipped;
        renderBulkImportGroups();
      });

      wrap.appendChild(row);
    });

    const activeCount = bulkImportGroups.filter((g) => !g.skipped).length;
    const confirmWrap = $('#bulkImportConfirmWrap');
    confirmWrap.classList.toggle('hidden', activeCount === 0);
    $('#confirmBulkImportBtn').textContent = `Import ${activeCount} ${activeCount === 1 ? 'entry' : 'entries'}`;
  }

  async function confirmBulkImport() {
    const toImport = bulkImportGroups.filter((g) => !g.skipped);
    const toDiscard = bulkImportGroups.filter((g) => g.skipped);

    for (const group of toDiscard) {
      for (const id of group.photoIds) await Photos.remove(id);
    }

    for (const group of toImport) {
      const entry = { dogId: currentDogId, date: group.date, type: 'photo', caption: '', photoIds: group.photoIds, tags: [] };
      if (group.location) entry.location = group.location;
      await Entries.add(entry);
    }

    bulkImportGroups = [];
    closeSheet($('#bulkImportSheet'));
    showToast(`Imported ${toImport.length} ${toImport.length === 1 ? 'entry' : 'entries'}`);
    if (activeTab === 'timeline') renderTimeline();
  }

  // ================= Full-screen photo viewer =================

  async function getPhotoViewerMedia(photoId) {
    if (fullUrlCache.has(photoId)) return fullUrlCache.get(photoId);
    const rec = await Photos.get(photoId).catch(() => null);
    if (!rec) {
      const empty = { url: '', mediaType: 'photo' };
      fullUrlCache.set(photoId, empty);
      return empty;
    }
    const mediaType = rec.mediaType || 'photo';
    const blob = mediaType === 'video' ? rec.videoBlob || rec.thumbBlob : rec.fullBlob || rec.thumbBlob;
    const result = { url: objectUrlFor(blob), mediaType };
    fullUrlCache.set(photoId, result);
    return result;
  }

  async function showPhotoViewerMedia() {
    const { photoIds, index } = photoViewerContext;
    const img = $('#pvImage');
    const video = $('#pvVideo');

    img.style.transform = '';
    img.classList.remove('snap-back');
    video.pause();
    video.removeAttribute('src');
    video.load();

    const { url, mediaType } = await getPhotoViewerMedia(photoIds[index]);
    if (mediaType === 'video') {
      img.classList.add('hidden');
      video.classList.remove('hidden');
      video.src = url;
    } else {
      video.classList.add('hidden');
      img.classList.remove('hidden');
      img.src = url;
    }

    $('#pvCounter').textContent = photoIds.length > 1 ? `${index + 1} / ${photoIds.length}` : '';
    $('#pvPrevBtn').disabled = index === 0;
    $('#pvNextBtn').disabled = index === photoIds.length - 1;
  }

  function photoViewerStep(delta) {
    const { photoIds, index } = photoViewerContext;
    const next = index + delta;
    if (next < 0 || next >= photoIds.length) return;
    photoViewerContext.index = next;
    showPhotoViewerMedia();
  }

  function openPhotoViewer(photoIds, startIndex) {
    if (!photoIds || !photoIds.length) return;
    photoViewerContext = { photoIds, index: Math.min(startIndex, photoIds.length - 1) };
    $('#photoViewer').classList.add('open');
    showPhotoViewerMedia();
  }

  function closePhotoViewer() {
    $('#photoViewer').classList.remove('open');
    $('#pvImage').src = '';
    const video = $('#pvVideo');
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function wirePhotoViewerSwipe() {
    const img = $('#pvImage');
    let startX = 0;
    let dragging = false;

    // Swipe-to-navigate applies only to the image element — a video has its
    // own native scrubber/controls that a competing swipe gesture would fight.
    img.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      dragging = true;
      img.classList.remove('snap-back');
    }, { passive: true });

    img.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      img.style.transform = `translateX(${dx}px)`;
    }, { passive: true });

    img.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : startX) - startX;
      const threshold = 70;

      img.classList.add('snap-back');
      if (dx < -threshold) {
        photoViewerStep(1);
      } else if (dx > threshold) {
        photoViewerStep(-1);
      } else {
        img.style.transform = 'translateX(0px)';
      }
    });
  }

  // ================= Stats dashboard =================

  async function renderStats() {
    const root = $('#screen-stats');
    const entries = await Entries.forDog(currentDogId);

    if (!entries.length) {
      root.innerHTML = emptyStateHtml('📊', 'Nothing to show yet', 'Stats will appear here once you start logging entries.');
      return;
    }

    const today = H.todayLocalStr();
    const months = H.entriesPerMonth(entries, 12, today);
    const maxCount = Math.max(1, ...months.map((m) => m.count));
    const streak = H.longestStreak(entries);
    const totalPhotos = entries.reduce((sum, e) => sum + (e.photoIds ? e.photoIds.length : 0), 0);

    const byType = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    const typeRows = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const meta = TYPE_META[type] || TYPE_META.note;
        return `<div class="weight-row"><span>${meta.icon} ${meta.label}</span><span class="w-val">${count}</span></div>`;
      })
      .join('');

    const barsHtml = months
      .map((m) => {
        const heightPct = Math.max(4, Math.round((m.count / maxCount) * 100));
        return `<div class="bar-col"><div class="bar" style="height:${heightPct}%" title="${m.count}"></div><div class="bar-label">${m.label}</div></div>`;
      })
      .join('');

    root.innerHTML = `
      <div class="recap-grid" style="margin-top:6px;">
        <div class="stat-card">
          <div class="value">${entries.length}</div>
          <div class="label">Total entries</div>
        </div>
        <div class="stat-card">
          <div class="value">${totalPhotos}</div>
          <div class="label">Photos</div>
        </div>
      </div>
      <div class="recap-grid">
        <div class="stat-card">
          <div class="value">${streak}</div>
          <div class="label">Longest streak (days)</div>
        </div>
        <div class="stat-card">
          <div class="value">${H.getAllTags(entries).length}</div>
          <div class="label">Distinct tags</div>
        </div>
      </div>
      <div class="chart-card">
        <div style="font-size:12px; color:var(--ink-soft); margin-bottom:4px;">Entries per month</div>
        <div class="bar-chart">${barsHtml}</div>
      </div>
      <div class="month-heading">By type</div>
      ${typeRows}
    `;
  }

  // ================= Recently Deleted =================

  const TRASH_RETENTION_DAYS = 30;

  // Permanently removes any soft-deleted entry (across ALL dogs, not just
  // the current one) that has been in the trash longer than the retention
  // window, cleaning up its photos too. Called once at boot.
  async function purgeExpiredTrash() {
    const now = Date.now();
    const allDogs = await Dogs.all();
    for (const dog of allDogs) {
      const trashed = await Entries.trashedForDog(dog.id);
      for (const entry of trashed) {
        if (H.isTrashExpired(entry.deletedAt, now, TRASH_RETENTION_DAYS)) {
          for (const id of entry.photoIds || []) await Photos.remove(id);
          await Entries.remove(entry.id);
          entryLookupById.delete(entry.id);
        }
      }
    }
  }

  async function openTrashSheet() {
    await renderTrashList();
    openSheet($('#trashSheet'));
  }

  async function renderTrashList() {
    const wrap = $('#trashList');
    const trashed = currentDogId ? await Entries.trashedForDog(currentDogId) : [];

    if (!trashed.length) {
      wrap.innerHTML = emptyStateHtml('🗑️', 'Nothing here', "Deleted entries for this dog will show up here for 30 days.");
      return;
    }

    const now = Date.now();
    wrap.innerHTML = '';
    trashed.forEach((entry) => {
      const daysLeft = Math.max(0, TRASH_RETENTION_DAYS - Math.floor((now - entry.deletedAt) / 86400000));
      const meta = TYPE_META[entry.type] || TYPE_META.note;
      const row = document.createElement('div');
      row.className = 'trash-row';
      row.innerHTML = `
        <div class="info">
          <div class="caption-preview">${meta.icon} ${escapeHtml(entry.caption || meta.label)}</div>
          <div class="meta-line">${H.formatDateLong(entry.date)} · deleted, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</div>
        </div>
        <div class="actions">
          <button type="button" class="restore-btn">Restore</button>
          <button type="button" class="purge-btn">Delete forever</button>
        </div>
      `;
      row.querySelector('.restore-btn').addEventListener('click', async () => {
        await Entries.restore(entry.id);
        const restored = await Entries.get(entry.id);
        entryLookupById.set(entry.id, restored);
        showToast('Restored');
        renderTrashList();
        if (activeTab === 'timeline') renderTimeline();
        else if (activeTab === 'profile') renderProfile();
      });
      row.querySelector('.purge-btn').addEventListener('click', async () => {
        if (!confirm('Permanently delete this entry? This cannot be undone.')) return;
        for (const id of entry.photoIds || []) await Photos.remove(id);
        await Entries.remove(entry.id);
        entryLookupById.delete(entry.id);
        showToast('Permanently deleted');
        renderTrashList();
      });
      wrap.appendChild(row);
    });
  }

  // ================= Puppy vaccination schedule =================

  function openVaccineScheduleSheet(dog) {
    pendingVaccineSchedule = H.puppyVaccinationSchedule(dog.birthday).map((s) => ({ ...s, skipped: false }));
    renderVaccineScheduleRows();
    openSheet($('#vaccineScheduleSheet'));
  }

  function renderVaccineScheduleRows() {
    const wrap = $('#vaccineScheduleRows');
    wrap.innerHTML = '';
    pendingVaccineSchedule.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'vaccine-row' + (item.skipped ? ' skipped' : '');
      row.innerHTML = `
        <div class="row-top">
          <span class="label">${escapeHtml(item.label)}</span>
          <button type="button" class="skip-btn">${item.skipped ? 'Include' : 'Skip'}</button>
        </div>
        <input type="date" value="${item.dueDate}" ${item.skipped ? 'disabled' : ''}>
      `;
      row.querySelector('input[type="date"]').addEventListener('change', (e) => {
        item.dueDate = e.target.value || item.dueDate;
      });
      row.querySelector('.skip-btn').addEventListener('click', () => {
        item.skipped = !item.skipped;
        renderVaccineScheduleRows();
      });
      wrap.appendChild(row);
    });
  }

  async function confirmVaccineSchedule() {
    const today = H.todayLocalStr();
    const toAdd = pendingVaccineSchedule.filter((s) => !s.skipped);
    for (const item of toAdd) {
      const entry = await Entries.add({
        dogId: currentDogId,
        date: today,
        type: 'vaccination',
        caption: item.label,
        photoIds: [],
        tags: [],
        nextDueDate: item.dueDate,
      });
      entryLookupById.set(entry.id, entry);
    }
    pendingVaccineSchedule = [];
    closeSheet($('#vaccineScheduleSheet'));
    showToast(`Added ${toAdd.length} reminder${toAdd.length === 1 ? '' : 's'}`);
    if (activeTab === 'profile') renderProfile();
    else if (activeTab === 'timeline') renderTimeline();
  }

  // ================= App Lock =================

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await window.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function getLockHash() {
    return localStorage.getItem('pawbook_lock_hash') || null;
  }

  function setLockHash(hash) {
    if (hash) localStorage.setItem('pawbook_lock_hash', hash);
    else localStorage.removeItem('pawbook_lock_hash');
  }

  function showLockScreen() {
    $('#lockPinInput').value = '';
    $('#lockError').textContent = '';
    $('#lockScreen').classList.add('open');
  }

  function hideLockScreen() {
    $('#lockScreen').classList.remove('open');
  }

  async function attemptUnlock() {
    const pin = $('#lockPinInput').value;
    const hash = await sha256Hex(pin);
    if (hash === getLockHash()) {
      hideLockScreen();
    } else {
      $('#lockError').textContent = 'Incorrect PIN';
      $('#lockPinInput').value = '';
    }
  }

  function renderLockSettings() {
    const wrap = $('#lockSettingsBody');
    if (!wrap) return;
    const hasLock = !!getLockHash();

    if (!hasLock) {
      wrap.innerHTML = `
        <div class="field"><label>New PIN (4–6 digits)</label><input type="password" inputmode="numeric" maxlength="6" id="newPin1"></div>
        <div class="field"><label>Confirm PIN</label><input type="password" inputmode="numeric" maxlength="6" id="newPin2"></div>
        <button class="btn btn-primary btn-block" id="setPinBtn">Set PIN</button>
      `;
      $('#setPinBtn').addEventListener('click', async () => {
        const p1 = $('#newPin1').value;
        const p2 = $('#newPin2').value;
        if (!/^\d{4,6}$/.test(p1)) {
          showToast('PIN must be 4–6 digits');
          return;
        }
        if (p1 !== p2) {
          showToast('PINs do not match');
          return;
        }
        setLockHash(await sha256Hex(p1));
        showToast('PIN set');
        renderLockSettings();
      });
    } else {
      wrap.innerHTML = `
        <p style="font-size:13px; color:var(--moss); margin-bottom:10px;">✓ PIN lock is on</p>
        <div class="field"><label>Enter current PIN to remove it</label><input type="password" inputmode="numeric" maxlength="6" id="removePinInput"></div>
        <button class="btn btn-secondary btn-block" id="removePinBtn">Remove PIN</button>
      `;
      $('#removePinBtn').addEventListener('click', async () => {
        const entered = $('#removePinInput').value;
        const hash = await sha256Hex(entered);
        if (hash !== getLockHash()) {
          showToast('Incorrect PIN');
          return;
        }
        setLockHash(null);
        showToast('PIN removed');
        renderLockSettings();
      });
    }
  }

  // ================= Share as image =================

  // Web Share API with files, falling back to a plain download (the same
  // pattern as backup export) when sharing files isn't supported — covers
  // desktop browsers and any Safari version without file-sharing support.
  async function shareBlob(blob, filename, shareText) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled — not an error
      console.warn('navigator.share failed, falling back to download', err);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Saved — share it from your Photos/Files app');
  }

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to decode for sharing'));
      img.src = URL.createObjectURL(blob);
    });
  }

  function truncateToWidth(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  // Composites a photo with a caption/date footer band, matching the app's
  // palette, for sharing outside the app. Videos are shared as-is (no
  // compositing — there's no straightforward way to burn a caption into
  // video without much heavier tooling than fits this app).
  async function buildEntryShareImage(photoId, entry) {
    const rec = await Photos.get(photoId).catch(() => null);
    if (!rec) return null;

    if (rec.mediaType === 'video') {
      return { blob: rec.videoBlob, filename: 'pawbook-video.mp4', shareText: entry.caption || '' };
    }

    const img = await loadImageFromBlob(rec.fullBlob || rec.thumbBlob);
    const footerH = Math.round(img.width * 0.12);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height + footerH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = '#F6F0E4';
    ctx.fillRect(0, img.height, img.width, footerH);

    const padX = img.width * 0.05;
    const caption = entry.caption || '';
    const dateLine = H.formatDateLong(entry.date);
    ctx.textBaseline = 'middle';
    if (caption) {
      ctx.fillStyle = '#2E2A22';
      ctx.font = `600 ${Math.round(img.width * 0.036)}px sans-serif`;
      ctx.fillText(truncateToWidth(ctx, caption, img.width - padX * 2), padX, img.height + footerH * 0.4);
      ctx.fillStyle = '#6B6555';
      ctx.font = `${Math.round(img.width * 0.026)}px sans-serif`;
      ctx.fillText(dateLine, padX, img.height + footerH * 0.72);
    } else {
      ctx.fillStyle = '#2E2A22';
      ctx.font = `600 ${Math.round(img.width * 0.032)}px sans-serif`;
      ctx.fillText(dateLine, padX, img.height + footerH * 0.5);
    }
    URL.revokeObjectURL(img.src);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return { blob, filename: 'pawbook-memory.jpg', shareText: caption };
  }

  async function shareCurrentViewerMedia() {
    const { photoIds, index } = photoViewerContext;
    const photoId = photoIds[index];
    let ownerEntry = null;
    for (const e of entryLookupById.values()) {
      if ((e.photoIds || []).includes(photoId)) {
        ownerEntry = e;
        break;
      }
    }
    const result = await buildEntryShareImage(photoId, ownerEntry || { caption: '', date: H.todayLocalStr() });
    if (!result) {
      showToast('Could not prepare that for sharing');
      return;
    }
    await shareBlob(result.blob, result.filename, result.shareText);
  }

  // Renders a standalone summary card (not a screenshot of the sheet) so it
  // looks intentional as a shared image rather than a UI crop.
  function buildRecapShareImage(dogName, recap) {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F6F0E4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#2E2A22';
    ctx.font = '700 44px sans-serif';
    ctx.fillText(`${dogName}'s ${recap.year}`, 60, 100);
    ctx.fillStyle = '#6B6555';
    ctx.font = '400 24px sans-serif';
    ctx.fillText('Year in Review', 60, 145);

    ctx.fillStyle = '#B5432E';
    ctx.font = '700 130px sans-serif';
    ctx.fillText(String(recap.totalEntries), 60, 320);
    ctx.fillStyle = '#6B6555';
    ctx.font = '400 26px sans-serif';
    ctx.fillText('entries logged', 60, 365);

    let y = 470;
    const line = (label, value) => {
      ctx.fillStyle = '#2E2A22';
      ctx.font = '600 32px sans-serif';
      ctx.fillText(value, 60, y);
      ctx.fillStyle = '#6B6555';
      ctx.font = '400 20px sans-serif';
      ctx.fillText(label, 60, y + 30);
      y += 100;
    };
    line('Walks', `${recap.walks.count} walks · ${recap.walks.totalKm.toFixed(1)} km`);
    line('Favorites', `${recap.favorites.length}`);
    if (recap.weight.first) {
      const change = recap.weight.change;
      const changeText = change !== null ? ` (${change > 0 ? '+' : ''}${change.toFixed(1)})` : '';
      line('Weight change', `${recap.weight.first.weightKg.toFixed(1)} → ${recap.weight.last.weightKg.toFixed(1)} kg${changeText}`);
    }

    ctx.fillStyle = '#B8AF9C';
    ctx.font = '400 18px sans-serif';
    ctx.fillText('🐾 Made with PawBook', 60, canvas.height - 40);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async function shareCurrentRecap() {
    const dog = dogs.find((d) => d.id === recapDogId);
    const year = Number($('#recapYearSelect').value);
    const entries = await Entries.forDog(recapDogId);
    const weights = await Weights.forDog(recapDogId);
    const recap = H.buildYearRecap(entries, weights, year);
    const dogName = dog ? dog.name : 'My dog';
    const blob = await buildRecapShareImage(dogName, recap);
    await shareBlob(blob, `pawbook-recap-${year}.png`, `${dogName}'s ${year} in review`);
  }

  // ================= Theme =================

  function resolveTheme(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  }

  function setThemePreference(mode) {
    localStorage.setItem('pawbook_theme', mode);
    applyTheme(mode);
  }

  function getThemePreference() {
    return localStorage.getItem('pawbook_theme') || 'system';
  }

  // ================= Backup screen =================

  function renderBackupScreen() {
    const root = $('#screen-backup');
    const currentPref = getThemePreference();
    root.innerHTML = `
      <div class="backup-card">
        <h3>Display</h3>
        <div class="type-toggle" id="themeToggle" style="grid-template-columns: repeat(3, 1fr);">
          <button type="button" data-mode="system" class="${currentPref === 'system' ? 'selected' : ''}">System</button>
          <button type="button" data-mode="light" class="${currentPref === 'light' ? 'selected' : ''}">Light</button>
          <button type="button" data-mode="dark" class="${currentPref === 'dark' ? 'selected' : ''}">Dark</button>
        </div>
      </div>
      <div class="backup-card">
        <h3>Recently Deleted</h3>
        <p>Deleted entries are kept for 30 days before being permanently removed.</p>
        <button class="btn btn-secondary btn-block" id="openTrashBtn">View Recently Deleted</button>
      </div>
      <div class="backup-card">
        <h3>App Lock</h3>
        <p>Adds a PIN prompt when opening PawBook. This is a basic privacy deterrent for casual snooping — not encryption. Your data isn't otherwise protected if someone accesses this device's storage directly.</p>
        <div id="lockSettingsBody"></div>
      </div>
      <div class="backup-card">
        <h3>Export backup</h3>
        <p>Saves everything — every dog, entry, photo, and weigh-in — to a single file you keep yourself (Files app, iCloud Drive, email to yourself, wherever). Since PawBook stores data only on this device, this is the only way it survives a lost or replaced phone.</p>
        <button class="btn btn-primary btn-block" id="exportBtn">Export backup</button>
        <div class="backup-status" id="exportStatus"></div>
      </div>
      <div class="backup-card">
        <h3>Restore from backup</h3>
        <p>Choose a previously exported backup file. Restoring is safe to repeat — it won't create duplicates, even if you import the same file twice.</p>
        <button class="btn btn-secondary btn-block" id="importBtn">Choose backup file…</button>
        <input type="file" id="importInput" accept="application/json" style="display:none;">
        <div class="backup-status" id="importStatus"></div>
      </div>
    `;

    $('#openTrashBtn').addEventListener('click', openTrashSheet);
    renderLockSettings();

    $$('#themeToggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        setThemePreference(btn.dataset.mode);
        $$('#themeToggle button').forEach((b) => b.classList.toggle('selected', b === btn));
      });
    });

    $('#exportBtn').addEventListener('click', async () => {
      const status = $('#exportStatus');
      status.classList.remove('error');
      status.textContent = 'Preparing export…';
      try {
        const summary = await window.Backup.exportBackup();
        status.textContent = `Exported ${summary.dogCount} dog(s), ${summary.entryCount} entries, ${summary.weightCount} weigh-ins, ${summary.photoCount} photos.`;
      } catch (err) {
        console.error('Export failed', err);
        status.classList.add('error');
        status.textContent = 'Export failed — please try again.';
      }
    });

    $('#importBtn').addEventListener('click', () => $('#importInput').click());

    $('#importInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const status = $('#importStatus');
      status.classList.remove('error');
      status.textContent = 'Restoring…';
      try {
        const payload = await window.Backup.readBackupFile(file);
        const summary = await window.Backup.restoreBackup(payload);
        status.textContent = `Restored ${summary.dogCount} dog(s), ${summary.entryCount} entries, ${summary.weightCount} weigh-ins, ${summary.photoCount} photos.`;
        photoUrlCache.clear();
        dogs = await Dogs.all();
        if (!dogs.some((d) => d.id === currentDogId)) currentDogId = dogs[0] ? dogs[0].id : null;
        persistCurrentDog();
        await renderDogSwitcher();
        showToast('Backup restored');
      } catch (err) {
        console.error('Restore failed', err);
        status.classList.add('error');
        status.textContent = err.message || 'That file could not be restored.';
      }
    });
  }

  // ================= Wire events =================

  let wired = false;
  function wireEvents() {
    if (wired) return;
    wired = true;

    tabBtns.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

    fab.addEventListener('click', () => {
      resetEntryForm();
      openSheet($('#entrySheet'));
    });

    $$('.type-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.type-toggle button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        $('#entrySheet').dataset.type = btn.dataset.type;
        updateTypeOnlyFields(btn.dataset.type);
      });
    });

    $('#photoInput').addEventListener('change', (e) => {
      handlePhotoSelection(e.target.files);
      e.target.value = '';
    });

    $('#entryDate').addEventListener('input', () => {
      // Only real user typing fires 'input'; our own auto-fill sets .value
      // directly, which does not — so this cleanly distinguishes the two.
      entryDateManuallyEdited = true;
    });

    $('#dogPhotoInput').addEventListener('change', (e) => {
      handleDogPhotoSelection(e.target.files);
      e.target.value = '';
    });

    $('#openBulkImportBtn').addEventListener('click', () => {
      resetBulkImportSheet();
      openSheet($('#bulkImportSheet'));
    });
    $('#chooseBulkPhotosBtn').addEventListener('click', () => $('#bulkPhotoInput').click());
    $('#bulkPhotoInput').addEventListener('change', (e) => {
      handleBulkPhotoSelection(e.target.files);
      e.target.value = '';
    });
    $('#confirmBulkImportBtn').addEventListener('click', confirmBulkImport);
    $('#cancelBulkImportBtn').addEventListener('click', cancelBulkImport);

    $('#sheetBackdrop').addEventListener('click', closeAllSheets);
    $$('.sheet-close').forEach((btn) => btn.addEventListener('click', () => closeSheet(btn.closest('.sheet'))));

    $('#saveEntryBtn').addEventListener('click', saveEntry);
    $('#saveDogBtn').addEventListener('click', saveDog);
    $('#dogSheetDelete').addEventListener('click', deleteDog);
    $('#saveWeightBtn').addEventListener('click', async () => {
      const date = $('#weightDate').value || H.todayLocalStr();
      const kg = parseFloat($('#weightKg').value);
      if (!kg || kg <= 0) {
        showToast('Enter a valid weight');
        return;
      }
      await Weights.add({ dogId: currentDogId, date, weightKg: kg, note: $('#weightNote').value.trim() });
      closeSheet($('#weightSheet'));
      showToast('Weight logged');
      if (activeTab === 'weight') renderWeight();
    });

    // Timeline search — debounced, and only re-renders #timelineContent, so
    // the search input (which lives outside that container) never loses focus.
    let searchDebounce;
    $('#timelineSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        timelineQuery = e.target.value;
        if (activeTab === 'timeline') renderTimeline();
      }, 150);
    });

    $$('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('.filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        timelineTypeFilter = chip.dataset.type;
        if (activeTab === 'timeline') renderTimeline();
      });
    });

    $('#allDogsToggle').addEventListener('click', () => {
      searchAllDogs = !searchAllDogs;
      $('#allDogsToggle').classList.toggle('active', searchAllDogs);
      if (activeTab === 'timeline') renderTimeline();
    });

    $('#recapYearSelect').addEventListener('change', async (e) => {
      const entries = await Entries.forDog(recapDogId);
      const weights = await Weights.forDog(recapDogId);
      renderRecapContent(entries, weights, Number(e.target.value));
    });

    $('#entrySheetDelete').addEventListener('click', deleteEntry);

    $('#pvCloseBtn').addEventListener('click', closePhotoViewer);
    $('#pvShareBtn').addEventListener('click', shareCurrentViewerMedia);
    $('#pvPrevBtn').addEventListener('click', () => photoViewerStep(-1));
    $('#pvNextBtn').addEventListener('click', () => photoViewerStep(1));
    $('#pvStage').addEventListener('click', (e) => {
      if (e.target.id === 'pvStage') closePhotoViewer();
    });
    wirePhotoViewerSwipe();

    $('#confirmVaccineScheduleBtn').addEventListener('click', confirmVaccineSchedule);
    $('#recapShareBtn').addEventListener('click', shareCurrentRecap);
  }

  // ================= Theme boot =================

  applyTheme(getThemePreference());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemePreference() === 'system') applyTheme('system');
    });
  }

  // ================= App Lock boot =================
  // Shown immediately (before boot()'s data loads) if a PIN is set, and
  // again any time the app returns to the foreground — an opaque overlay,
  // so nothing underneath is visible until unlocked either way.

  if (getLockHash()) showLockScreen();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getLockHash()) showLockScreen();
  });
  document.addEventListener('DOMContentLoaded', () => {
    $('#lockUnlockBtn').addEventListener('click', attemptUnlock);
    $('#lockPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptUnlock();
    });
  });

  // ================= Service worker =================

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
