const DEFAULT_CITY = { name: 'Алматы', latitude: 43.2389, longitude: 76.8897, zoom: 12 };
let selectedCity = { ...DEFAULT_CITY };
const map = L.map('map', { zoomControl: false }).setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const routeLayer = L.featureGroup().addTo(map);
const greenLayer = L.layerGroup().addTo(map);
const heatLayer = L.layerGroup().addTo(map);
const waterLayer = L.layerGroup().addTo(map);
const userLocationLayer = L.layerGroup().addTo(map);
let routeData = null;
let activeRoute = 'cool';
let transportMode = 'foot';
let mapSelectionMode = null;
let startPoint = null;
let endPoint = null;
let reportTarget = null;
let toastTimer;
let cityDataRevision = 0;
let routeRequestRevision = 0;
let isLocating = false;
let mapLocateButton;
let citySearchTimer;
let citySearchRevision = 0;
let citySearchLastRequestAt = 0;
let citySearchController;

const $ = (id) => document.getElementById(id);
const startInput = $('startInput');
const endInput = $('endInput');
const routeButton = $('routeButton');
const routeError = $('routeError');
const cityPicker = $('cityPicker');
const cityButton = $('cityButton');
const citySearchInput = $('citySearchInput');
const citySearchStatus = $('citySearchStatus');
const citySearchResults = $('citySearchResults');
const locateButton = $('locateButton');
const locationStatus = $('locationStatus');

const LocationControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate');
    mapLocateButton = L.DomUtil.create('button', '', container);
    mapLocateButton.type = 'button';
    mapLocateButton.title = 'Найти меня на карте';
    mapLocateButton.setAttribute('aria-label', 'Найти моё местоположение на карте');
    mapLocateButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="2"></circle><path d="M12 2v3m0 14v3M2 12h3m14 0h3"></path></svg>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(mapLocateButton, 'click', locateUser);
    return container;
  },
});
new LocationControl().addTo(map);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'Сервер вернул ответ в неподдерживаемом формате.'
        : `Сервис временно недоступен (ошибка ${response.status}).`,
    );
  }
  if (!response.ok) throw new Error(payload.detail || 'Не удалось выполнить запрос.');
  return payload;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function updateCityLabels() {
  $('cityLabel').textContent = selectedCity.name;
  $('mapCityLabel').textContent = selectedCity.name;
  $('map').setAttribute('aria-label', `Интерактивная карта: ${selectedCity.name}`);
}

function reportCountLabel(count) {
  const remainder = count % 10;
  const lastTwoDigits = count % 100;
  const noun = remainder === 1 && lastTwoDigits !== 11
    ? 'отметка'
    : remainder >= 2 && remainder <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)
      ? 'отметки'
      : 'отметок';
  return `${count} ${noun}`;
}

function preferredSearchLanguage() {
  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  return languages.filter(Boolean).join(',').slice(0, 100);
}

function refreshCityData() {
  cityDataRevision += 1;
  greenLayer.clearLayers();
  heatLayer.clearLayers();
  waterLayer.clearLayers();
  $('temperatureValue').textContent = '—°';
  $('feelsLike').textContent = 'Загружаем погоду…';
  document.querySelector('.heat-meter > span').style.width = '0%';
  $('reportCount').textContent = '0';
  $('hotspotList').innerHTML = '<span class="empty-hotspots">Загружаем отметки…</span>';
  loadWeather(cityDataRevision);
  loadPlaces(cityDataRevision);
  loadReports(cityDataRevision);
  loadInsights(cityDataRevision);
}

function closeCityPicker() {
  window.clearTimeout(citySearchTimer);
  citySearchRevision += 1;
  citySearchController?.abort();
  cityPicker.hidden = true;
  cityButton.setAttribute('aria-expanded', 'false');
  citySearchInput.setAttribute('aria-expanded', 'false');
  citySearchResults.replaceChildren();
  $('citySearchButton').disabled = false;
  $('citySearchButton').removeAttribute('aria-busy');
}

function selectCity(city) {
  selectedCity = {
    name: city.name,
    latitude: Number(city.latitude),
    longitude: Number(city.longitude),
    zoom: 13,
  };
  updateCityLabels();
  closeCityPicker();
  citySearchInput.value = '';
  citySearchResults.replaceChildren();
  citySearchStatus.textContent = 'Город выбран.';
  invalidateRouteData();
  startPoint = null;
  endPoint = null;
  startInput.value = '';
  endInput.value = '';
  startInput.dataset.resolvedName = '';
  endInput.dataset.resolvedName = '';
  map.setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
  setMapMode(null);
  locationStatus.textContent = '';
  locationStatus.classList.remove('error');
  refreshCityData();
  showToast(`Карта обновлена: ${selectedCity.name}`);
}

function scheduleCitySearch(immediate = false) {
  window.clearTimeout(citySearchTimer);
  citySearchRevision += 1;
  const revision = citySearchRevision;
  const query = citySearchInput.value.trim();
  citySearchController?.abort();
  const searchButton = $('citySearchButton');
  searchButton.disabled = false;
  searchButton.removeAttribute('aria-busy');
  citySearchResults.replaceChildren();

  if (query.length < 2) {
    citySearchInput.setAttribute('aria-expanded', 'false');
    citySearchStatus.textContent = 'Введите не менее двух символов — на любом языке.';
    return;
  }

  citySearchStatus.textContent = immediate
    ? 'Ищем точные и похожие города…'
    : 'Вводите название города — покажем подходящие варианты…';
  citySearchInput.setAttribute('aria-expanded', 'false');
  citySearchTimer = window.setTimeout(
    () => requestCitySuggestions(query, revision),
    immediate ? 0 : 650,
  );
}

async function requestCitySuggestions(query, revision) {
  if (revision !== citySearchRevision) return;
  const waitForRateLimit = Math.max(0, 1000 - (Date.now() - citySearchLastRequestAt));
  if (waitForRateLimit) {
    citySearchTimer = window.setTimeout(
      () => requestCitySuggestions(query, revision),
      waitForRateLimit,
    );
    return;
  }

  const searchButton = $('citySearchButton');
  const controller = new AbortController();
  citySearchController = controller;
  citySearchLastRequestAt = Date.now();
  searchButton.disabled = true;
  searchButton.setAttribute('aria-busy', 'true');
  try {
    const parameters = new URLSearchParams({
      q: query,
      language: preferredSearchLanguage(),
    });
    const results = await api(`/api/cities?${parameters}`, { signal: controller.signal });
    if (revision !== citySearchRevision) return;
    if (!results.length) {
        citySearchStatus.textContent = `По запросу «${query}» города не найдены. Попробуйте другое написание или язык.`;
      return;
    }
    const exactCount = results.filter((city) => city.match_type === 'exact').length;
    citySearchStatus.textContent = exactCount
        ? 'Точное совпадение показано первым. Остальные результаты ранжированы по запросу:'
        : 'Города, наиболее подходящие к запросу. Уточните страну, если вариантов несколько:';
    const entries = results.map((city) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong');
      name.textContent = city.name;
      const details = document.createElement('small');
      details.textContent = city.display_name;
      const match = document.createElement('span');
      match.className = `city-match${city.match_type === 'exact' ? ' exact' : ''}`;
      match.textContent = city.match_type === 'exact' ? 'Точное совпадение' : 'Результат поиска';
      button.append(name, match, details);
      button.addEventListener('click', () => selectCity(city));
      item.append(button);
      return item;
    });
    citySearchResults.replaceChildren(...entries);
    citySearchInput.setAttribute('aria-expanded', 'true');
  } catch (error) {
    if (error.name !== 'AbortError' && revision === citySearchRevision) {
      citySearchStatus.textContent = error.message;
    }
  } finally {
    if (revision === citySearchRevision) {
      searchButton.disabled = false;
      searchButton.removeAttribute('aria-busy');
      citySearchInput.setAttribute('aria-expanded', String(citySearchResults.childElementCount > 0));
    }
  }
}

function searchCities(event) {
  event.preventDefault();
  scheduleCitySearch(true);
}

function markerIcon(label, isEnd = false) {
  return L.divIcon({
    className: '',
    html: `<span class="route-marker${isEnd ? ' end' : ''}">${label}</span>`,
    iconSize: [25, 25],
    iconAnchor: [12, 12],
  });
}

function setPoint(type, latlng, label) {
  const point = { latitude: latlng.lat, longitude: latlng.lng };
  if (type === 'start') {
    startPoint = point;
    startInput.value = label || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    startInput.dataset.resolvedName = label || '';
  } else {
    endPoint = point;
    endInput.value = label || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    endInput.dataset.resolvedName = label || '';
  }
  invalidateRouteData();
  drawRoutePoints();
}

function invalidateRouteData() {
  routeRequestRevision += 1;
  routeData = null;
  activeRoute = 'cool';
  routeLayer.clearLayers();
  $('routeResults').hidden = true;
  routeButton.disabled = false;
  $('footMode').disabled = false;
  $('bikeMode').disabled = false;
  routeButton.querySelector('span').textContent = 'Найти прохладный путь';
}

function clearRouteDisplay() {
  routeData = null;
  activeRoute = 'cool';
  routeLayer.clearLayers();
  $('routeResults').hidden = true;
}

function drawRoutePoints() {
  routeLayer.eachLayer((layer) => {
    if (layer.options && layer.options.pointMarker) routeLayer.removeLayer(layer);
  });
  if (startPoint) {
    const marker = L.marker([startPoint.latitude, startPoint.longitude], { icon: markerIcon('A'), draggable: true });
    marker.options.pointMarker = true;
    marker.on('dragend', (event) => {
      const location = event.target.getLatLng();
      startPoint = { latitude: location.lat, longitude: location.lng };
      startInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
      invalidateRouteData();
      drawRoutePoints();
    });
    routeLayer.addLayer(marker);
  }
  if (endPoint) {
    const marker = L.marker([endPoint.latitude, endPoint.longitude], { icon: markerIcon('Б', true), draggable: true });
    marker.options.pointMarker = true;
    marker.on('dragend', (event) => {
      const location = event.target.getLatLng();
      endPoint = { latitude: location.lat, longitude: location.lng };
      endInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
      invalidateRouteData();
      drawRoutePoints();
    });
    routeLayer.addLayer(marker);
  }
}

function parseCoordinates(value) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) {
    return { latitude: first, longitude: second };
  }
  return null;
}

async function resolveLocation(input, currentPoint) {
  const coordinates = parseCoordinates(input.value);
  if (coordinates) return coordinates;
  if (currentPoint && input.value.trim() === input.dataset.resolvedName) return currentPoint;
  const parameters = new URLSearchParams({
    q: input.value.trim(),
    language: preferredSearchLanguage(),
  });
  const results = await api(`/api/geocode?${parameters}`);
  if (!results.length) throw new Error(`Не удалось найти адрес «${input.value.trim()}». Попробуйте указать более точное место.`);
  const place = results[0];
  input.value = place.name.split(',').slice(0, 3).join(', ');
  input.dataset.resolvedName = input.value;
  return { latitude: Number(place.latitude), longitude: Number(place.longitude) };
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(meters)} м`;
}

function formatTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `около ${minutes} мин`;
  return `около ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function drawRoutes() {
  routeLayer.eachLayer((layer) => {
    if (!layer.options || !layer.options.pointMarker) routeLayer.removeLayer(layer);
  });
  drawRoutePoints();
  if (!routeData) return;
  const selectedIds = new Set([
    routeData.cool_route_id,
    routeData.ordinary_route_id,
    routeData.short_route_id,
  ]);
  const activeRouteId = routeData[`${activeRoute}_route_id`];
  for (const route of routeData.routes) {
    if (!selectedIds.has(route.id)) continue;
    const isActive = route.id === activeRouteId;
    const line = L.geoJSON({ type: 'LineString', coordinates: route.geometry }, {
      style: { color: isActive ? '#2c875a' : '#82928a', weight: isActive ? 6 : 4, opacity: isActive ? 0.9 : 0.48, dashArray: isActive ? null : '7 8' },
    });
    routeLayer.addLayer(line);
  }
  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.13), { maxZoom: 16 });
}

function updateRouteCards() {
  const cool = routeData.routes.find((route) => route.id === routeData.cool_route_id);
  const ordinary = routeData.routes.find((route) => route.id === routeData.ordinary_route_id);
  const short = routeData.routes.find((route) => route.id === routeData.short_route_id);
  const environmentSummary = cool.green_points === null
    ? 'Экоданные временно недоступны'
    : `${cool.green_points} зелёных зон · ${cool.water_points} мест с водой`;
  const greenSeparator = environmentSummary ? ` · ${environmentSummary}` : '';
  $('coolMeta').textContent = `${formatDistance(cool.distance)} · ${formatTime(cool.duration)}${greenSeparator}`;
  $('coolScore').textContent = `${cool.comfort}/100`;
  $('ordinaryMeta').textContent = ordinary.id === cool.id
    ? `${formatDistance(ordinary.distance)} · совпадает с прохладным`
    : ordinary.id === short.id
      ? `${formatDistance(ordinary.distance)} · совпадает с коротким`
      : `${formatDistance(ordinary.distance)} · ${formatTime(ordinary.duration)}`;
  $('ordinaryScore').textContent = `${ordinary.comfort}/100`;
  $('shortMeta').textContent = short.id === cool.id
    ? `${formatDistance(short.distance)} · совпадает с прохладным`
    : short.id === ordinary.id
      ? `${formatDistance(short.distance)} · совпадает с обычным`
      : `${formatDistance(short.distance)} · ${formatTime(short.duration)}`;
  $('shortScore').textContent = `${short.comfort}/100`;
  $('coolOption').classList.toggle('active', activeRoute === 'cool');
  $('normalOption').classList.toggle('active', activeRoute === 'ordinary');
  $('shortOption').classList.toggle('active', activeRoute === 'short');
  $('coolOption').setAttribute('aria-pressed', String(activeRoute === 'cool'));
  $('normalOption').setAttribute('aria-pressed', String(activeRoute === 'ordinary'));
  $('shortOption').setAttribute('aria-pressed', String(activeRoute === 'short'));
  $('routeResults').hidden = false;
  if (cool.green_points === null) showToast('Экоданные недоступны: индекс рассчитан по длине пути и погоде');
  else if (routeData.temperature === null && routeData.weather_warning) {
    showToast('Погодные данные недоступны: маршрут построен без учёта температуры');
  }
}

function activateRoute(which) {
  if (!routeData) return;
  activeRoute = which;
  updateRouteCards();
  drawRoutes();
}

async function findRoutes(event) {
  event.preventDefault();
  const requestRevision = ++routeRequestRevision;
  setMapMode(null);
  routeError.textContent = '';
  routeButton.disabled = true;
  $('footMode').disabled = true;
  $('bikeMode').disabled = true;
  routeButton.querySelector('span').textContent = 'Ищем путь…';
  try {
    startPoint = await resolveLocation(startInput, startPoint);
    if (requestRevision !== routeRequestRevision) return;
    endPoint = await resolveLocation(endInput, endPoint);
    if (requestRevision !== routeRequestRevision) return;
    const start = `${startPoint.longitude},${startPoint.latitude}`;
    const end = `${endPoint.longitude},${endPoint.latitude}`;
    const result = await api(
      `/api/routes?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&mode=${transportMode}`,
    );
    if (requestRevision !== routeRequestRevision) return;
    routeData = result;
    activeRoute = 'cool';
    drawRoutePoints();
    updateRouteCards();
    drawRoutes();
  } catch (error) {
    if (requestRevision !== routeRequestRevision) return;
    routeError.textContent = error.message;
    clearRouteDisplay();
    drawRoutePoints();
  } finally {
    if (requestRevision === routeRequestRevision) {
      routeButton.disabled = false;
      $('footMode').disabled = false;
      $('bikeMode').disabled = false;
      routeButton.querySelector('span').textContent = 'Найти прохладный путь';
    }
  }
}

function selectTransport(mode) {
  if (mode === transportMode) return;
  transportMode = mode;
  $('footMode').classList.toggle('active', mode === 'foot');
  $('footMode').setAttribute('aria-pressed', String(mode === 'foot'));
  $('bikeMode').classList.toggle('active', mode === 'bike');
  $('bikeMode').setAttribute('aria-pressed', String(mode === 'bike'));
  invalidateRouteData();
  drawRoutePoints();
  routeError.textContent = '';
  if (startInput.value.trim() && endInput.value.trim()) {
    $('routeForm').requestSubmit();
  } else {
    showToast(mode === 'bike' ? 'Выбран велосипедный маршрут' : 'Выбран пешеходный маршрут');
  }
}

function setMapMode(mode) {
  mapSelectionMode = mode;
  const instruction = $('mapInstruction');
  instruction.hidden = !mode;
  instruction.textContent = mode === 'report'
    ? 'Нажмите на карту, чтобы отметить проблему'
    : mode === 'start'
      ? 'Нажмите на карту, чтобы выбрать точку отправления'
      : mode === 'end'
        ? 'Нажмите на карту, чтобы выбрать точку назначения'
        : '';
}

function beginReportMode() {
  setMapMode('report');
  showToast('Нажмите на карте, чтобы отметить место, где нужна прохлада');
}

function reportCategoryLabel(category) {
  return {
    hot: 'Здесь жарко',
    no_shade: 'Не хватает тени',
    no_water: 'Нет питьевой воды',
  }[category] || 'Сообщение жителя';
}

function reportPopupContent(category, note = '') {
  const content = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = reportCategoryLabel(category);
  content.append(label);
  if (note) {
    const noteText = document.createElement('p');
    noteText.className = 'report-popup-note';
    noteText.textContent = note;
    content.append(noteText);
  }
  return content;
}

function addHeatReportMarker(report) {
  const markerClass = report.category === 'hot'
    ? 'hot'
    : report.category === 'no_water'
      ? 'water'
      : 'shade';
  L.marker([report.latitude, report.longitude], {
    icon: L.divIcon({
      className: '',
      html: `<span class="custom-marker ${markerClass}"></span>`,
      iconSize: [19, 19],
      iconAnchor: [9, 9],
    }),
  }).bindPopup(reportPopupContent(report.category, report.note)).addTo(heatLayer);
}

function openReportConfirmation(latlng) {
  reportTarget = { latitude: latlng.lat, longitude: latlng.lng };
  const form = document.createElement('form');
  form.className = 'report-popup-form';
  const heading = document.createElement('strong');
  heading.textContent = 'Что здесь нужно улучшить?';

  const categoryLabel = document.createElement('label');
  categoryLabel.textContent = 'Проблема';
  const category = document.createElement('select');
  category.name = 'category';
  [
    ['hot', 'Сильная жара'],
    ['no_shade', 'Не хватает тени'],
    ['no_water', 'Нет питьевой воды'],
  ].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    category.append(option);
  });
  categoryLabel.append(category);

  const noteLabel = document.createElement('label');
  noteLabel.textContent = 'Комментарий (необязательно)';
  const note = document.createElement('textarea');
  note.name = 'note';
  note.maxLength = 240;
  note.rows = 2;
  note.placeholder = 'Например: после полудня здесь совсем нет тени';
  noteLabel.append(note);

  const submit = document.createElement('button');
  submit.className = 'popup-report-button';
  submit.type = 'submit';
  submit.textContent = 'Отправить отметку';
  form.append(heading, categoryLabel, noteLabel, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitHeatReport(category.value, note.value, submit);
  });
  L.popup().setLatLng(latlng).setContent(form).openOn(map);
}

map.on('click', (event) => {
  if (!mapSelectionMode) return;
  if (mapSelectionMode === 'report') {
    setMapMode(null);
    openReportConfirmation(event.latlng);
    return;
  }
  const selectedMode = mapSelectionMode;
  setPoint(selectedMode, event.latlng);
  setMapMode(null);
  showToast(selectedMode === 'start' ? 'Точка отправления выбрана' : 'Точка назначения выбрана');
});

function bindRouteOption(id, which) {
  const element = $(id);
  element.addEventListener('click', () => activateRoute(which));
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRoute(which);
    }
  });
}
bindRouteOption('coolOption', 'cool');
bindRouteOption('normalOption', 'ordinary');
bindRouteOption('shortOption', 'short');

$('routeForm').addEventListener('submit', findRoutes);
$('swapLocations').addEventListener('click', () => {
  const startValue = startInput.value;
  const startResolvedName = startInput.dataset.resolvedName || '';
  startInput.value = endInput.value;
  startInput.dataset.resolvedName = endInput.dataset.resolvedName || '';
  endInput.value = startValue;
  endInput.dataset.resolvedName = startResolvedName;
  [startPoint, endPoint] = [endPoint, startPoint];
  setMapMode(null);
  routeError.textContent = '';
  invalidateRouteData();
  drawRoutePoints();
});
$('footMode').addEventListener('click', () => selectTransport('foot'));
$('bikeMode').addEventListener('click', () => selectTransport('bike'));
$('citySearchForm').addEventListener('submit', searchCities);
citySearchInput.addEventListener('input', () => scheduleCitySearch());
citySearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    const firstResult = citySearchResults.querySelector('button');
    if (firstResult) {
      event.preventDefault();
      firstResult.focus();
    }
  }
});
citySearchResults.addEventListener('keydown', (event) => {
  const option = event.target.closest('button');
  if (!option) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const options = [...citySearchResults.querySelectorAll('button')];
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = options[(options.indexOf(option) + offset + options.length) % options.length];
    event.preventDefault();
    options.forEach((candidate) => candidate.setAttribute('aria-selected', String(candidate === next)));
    next.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    citySearchInput.focus();
  }
});
cityButton.addEventListener('click', () => {
  cityPicker.hidden = !cityPicker.hidden;
  cityButton.setAttribute('aria-expanded', String(!cityPicker.hidden));
  if (!cityPicker.hidden) {
    citySearchInput.focus();
    if (citySearchInput.value.trim().length >= 2) scheduleCitySearch(true);
  }
});
document.addEventListener('click', (event) => {
  if (!cityPicker.contains(event.target) && !cityButton.contains(event.target)) closeCityPicker();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !cityPicker.hidden) {
    closeCityPicker();
    cityButton.focus();
  }
});
startInput.addEventListener('focus', () => setMapMode('start'));
endInput.addEventListener('focus', () => setMapMode('end'));
startInput.addEventListener('input', () => {
  startPoint = null;
  startInput.dataset.resolvedName = '';
  invalidateRouteData();
  drawRoutePoints();
});
endInput.addEventListener('input', () => {
  endPoint = null;
  endInput.dataset.resolvedName = '';
  invalidateRouteData();
  drawRoutePoints();
});
$('clearRoutes').addEventListener('click', () => {
  invalidateRouteData();
  startPoint = null;
  endPoint = null;
  startInput.value = '';
  endInput.value = '';
  startInput.dataset.resolvedName = '';
  endInput.dataset.resolvedName = '';
  map.setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
});
$('mapReportButton').addEventListener('click', beginReportMode);
$('reportButton').addEventListener('click', beginReportMode);
function setLocating(isBusy) {
  isLocating = isBusy;
  locateButton.disabled = isBusy;
  mapLocateButton.disabled = isBusy;
  mapLocateButton.classList.toggle('loading', isBusy);
  mapLocateButton.setAttribute('aria-busy', String(isBusy));
}

function showLocationError(message) {
  locationStatus.textContent = message;
  locationStatus.classList.add('error');
  showToast(message);
}

function locateUser() {
  if (isLocating) return;
  locationStatus.classList.remove('error');
  if (!navigator.geolocation) {
    showLocationError('Этот браузер не поддерживает определение местоположения.');
    return;
  }
  if (!window.isSecureContext) {
    showLocationError('Геолокация работает только на localhost или защищённом HTTPS-сайте.');
    return;
  }
  setLocating(true);
  locationStatus.textContent = 'Определяем ваше местоположение… Разрешите доступ, если браузер спросит.';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
      if (!Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)
        || Math.abs(latlng.lat) > 90 || Math.abs(latlng.lng) > 180) {
        setLocating(false);
        showLocationError('Браузер вернул некорректные координаты. Попробуйте ещё раз.');
        return;
      }
      const accuracy = Math.round(position.coords.accuracy);
      setPoint('start', latlng, 'Моё местоположение');
      selectedCity = {
        name: 'Моё местоположение',
        latitude: latlng.lat,
        longitude: latlng.lng,
        zoom: 17,
      };
      updateCityLabels();
      userLocationLayer.clearLayers();
      L.circle(latlng, {
        radius: Math.max(accuracy, 20),
        color: '#3188bd',
        weight: 1,
        fillColor: '#55a9d8',
        fillOpacity: 0.12,
      }).addTo(userLocationLayer);
      L.marker(latlng, {
        icon: L.divIcon({
          className: 'user-location-icon',
          html: '<span class="user-location-dot"></span>',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: `Вы здесь · точность около ${accuracy} м`,
      }).bindPopup(`Вы здесь · точность около ${accuracy} м`).addTo(userLocationLayer);
      map.setView(latlng, Math.max(map.getZoom(), 17), { animate: true });
      setMapMode('end');
      endInput.focus();
      locationStatus.textContent = `Местоположение определено (точность около ${accuracy} м). Введите точку назначения.`;
      refreshCityData();
      setLocating(false);
      showToast('Вы на карте. Масштаб увеличен для удобного выбора места.');
    },
    (error) => {
      const message = error.code === 1
        ? 'Доступ запрещён. Разрешите геолокацию для этого сайта в настройках браузера.'
        : error.code === 2
          ? 'Не удалось определить координаты. Проверьте GPS или подключение к сети.'
          : 'Определение местоположения заняло слишком много времени. Попробуйте ещё раз.';
      setLocating(false);
      showLocationError(message);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
  );
}

locateButton.addEventListener('click', locateUser);

document.querySelectorAll('.layer-chip').forEach((button) => {
  button.addEventListener('click', () => {
    const layerName = button.dataset.layer;
    const isActive = button.classList.toggle('active');
    button.setAttribute('aria-pressed', String(isActive));
    const layer = { green: greenLayer, heat: heatLayer, water: waterLayer }[layerName];
    if (isActive) layer.addTo(map);
    else map.removeLayer(layer);
  });
});

async function submitHeatReport(category, note, submitButton) {
  if (!reportTarget) return;
  submitButton.disabled = true;
  submitButton.textContent = 'Отправляем…';
  try {
    const saved = await api('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reportTarget, category, note: note.trim() }),
    });
    addHeatReportMarker(saved);
    map.closePopup();
    $('reportStatus').textContent = 'Спасибо! Отметка добавлена на карту.';
    showToast('Спасибо, сообщение отправлено');
    reportTarget = null;
    await loadInsights();
  } catch (error) {
    showToast(error.message);
    submitButton.disabled = false;
    submitButton.textContent = 'Отправить отметку';
  }
}

async function loadWeather(revision = cityDataRevision) {
  try {
    const conditions = await api(
      `/api/weather?latitude=${selectedCity.latitude}&longitude=${selectedCity.longitude}`,
    );
    if (revision !== cityDataRevision) return;
    if (conditions.temperature === null) {
      $('feelsLike').textContent = 'Погода пока недоступна';
      return;
    }
    $('temperatureValue').textContent = `${Math.round(conditions.temperature)}°`;
    const feels = conditions.apparent_temperature;
    $('feelsLike').textContent = feels === null
      ? `${selectedCity.name}, сейчас`
      : `Ощущается как ${Math.round(feels)}°`;
    const width = Math.max(5, Math.min(100, ((conditions.temperature + 5) / 45) * 100));
    document.querySelector('.heat-meter > span').style.width = `${width}%`;
  } catch {
    if (revision === cityDataRevision) $('feelsLike').textContent = 'Погода пока недоступна';
  }
}

async function loadReports(revision = cityDataRevision) {
  try {
    const query = new URLSearchParams({
      latitude: String(selectedCity.latitude),
      longitude: String(selectedCity.longitude),
    });
    const reports = await api(`/api/reports?${query}`);
    if (revision !== cityDataRevision) return;
    reports.forEach((report) => {
      addHeatReportMarker(report);
    });
  } catch (error) {
    if (revision === cityDataRevision) showToast(error.message);
  }
}

async function loadInsights(revision = cityDataRevision) {
  try {
    const query = new URLSearchParams({
      latitude: String(selectedCity.latitude),
      longitude: String(selectedCity.longitude),
    });
    const insights = await api(`/api/city-insights?${query}`);
    if (revision !== cityDataRevision) return;
    $('reportCount').textContent = reportCountLabel(insights.total_reports);
    const list = $('hotspotList');
    if (!insights.hotspots.length) {
      list.innerHTML = '<span class="empty-hotspots">Пока нет отметок — добавьте первую.</span>';
      return;
    }
    list.replaceChildren(...insights.hotspots.slice(0, 3).map((spot) => {
      const row = document.createElement('span');
      row.className = 'hotspot-item';
      const place = document.createElement('span');
      place.textContent = `${Number(spot.latitude).toFixed(3)}, ${Number(spot.longitude).toFixed(3)}`;
      const count = document.createElement('strong');
      count.textContent = reportCountLabel(spot.reports);
      row.append(place, count);
      return row;
    }));
  } catch (error) {
    if (revision === cityDataRevision) showToast(error.message);
  }
}

function setupMapLayers() {
  greenLayer.addTo(map);
  heatLayer.addTo(map);
}

async function loadPlaces(revision = cityDataRevision) {
  try {
    const places = await api(
      `/api/places?latitude=${selectedCity.latitude}&longitude=${selectedCity.longitude}`,
    );
    if (revision !== cityDataRevision) return;
    places.forEach((place) => {
      const isWater = place.type === 'water';
      const marker = L.marker([place.latitude, place.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<span class="custom-marker${isWater ? ' water' : ''}"></span>`,
          iconSize: [19, 19],
          iconAnchor: [9, 9],
        }),
      }).bindPopup(place.name);
      marker.addTo(isWater ? waterLayer : greenLayer);
    });
  } catch {
    if (revision === cityDataRevision) {
      showToast('Не удалось загрузить городские зелёные зоны из OpenStreetMap');
    }
  }
}

setupMapLayers();
updateCityLabels();
refreshCityData();
