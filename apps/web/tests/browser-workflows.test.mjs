import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startBrowserServer } from "./helpers/browser-server.mjs";
import { equipmentScenario } from "./helpers/brigade-equipment.mjs";
import { commonScenario } from "./helpers/common-plan.mjs";
import { routeComparisonScenario } from "./helpers/route-comparison.mjs";
import { compositeReportScenario } from "./helpers/composite-report.mjs";

test('UI-27 work type report fields and evidence policy persist as a new version',async t=>{
  const page=await pageFor(t);
  const category=(await host.app.json('/api/admin/work-categories',{method:'POST',body:{name:'Измерения',description:'',active:true}},201)).item;
  await page.goto(`${host.origin}/admin`);await page.getByRole('tab',{name:'Типы заявок',exact:true}).click();
  await page.getByRole('button',{name:'Добавить тип HD',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Название типа HD *',{exact:true}).fill('Акт измерения');
  await dialog.getByRole('checkbox',{name:'Измерения',exact:true}).check();
  await dialog.getByRole('combobox',{name:/^Тип проверки/}).selectOption('dispatcher');
  await dialog.getByRole('button',{name:'Добавить поле отчёта',exact:true}).click();
  await dialog.getByLabel('Поле отчёта 1',{exact:true}).fill('Уровень сигнала');
  await dialog.getByLabel('Минимум фотографий',{exact:true}).fill('1');await dialog.getByLabel('Минимум видео',{exact:true}).fill('1');
  await dialog.getByRole('button',{name:'Создать тип HD',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const saved=(await host.app.json('/api/admin/bootstrap')).workTypes.find(item=>item.name==='Акт измерения');
  assert.deepEqual(saved.categoryIds,[category.id]);assert.equal(saved.reportTemplate.fields[0].required,true);assert.deepEqual(saved.evidencePolicy,{minPhotos:1,minVideos:1});
  await page.reload();await page.getByRole('tab',{name:'Типы заявок',exact:true}).click();
  await page.getByRole('button',{name:'Редактировать тип HD Акт измерения',exact:true}).click();
  assert.equal(await dialog.getByLabel('Поле отчёта 1',{exact:true}).inputValue(),'Уровень сигнала');
  await dialog.getByLabel('Описание',{exact:true}).fill('Сохранить требования');
  await dialog.getByRole('button',{name:'Сохранить изменения',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const edited=(await host.app.json('/api/admin/bootstrap')).workTypes.find(item=>item.id===saved.id);
  assert.notEqual(edited.versionId,saved.versionId);assert.deepEqual(edited.reportTemplate,saved.reportTemplate);assert.deepEqual(edited.evidencePolicy,saved.evidencePolicy);
});

test('UI-28 dispatcher sees both HD report fields with their saved versions',async t=>{
  const page=await pageFor(t),f=await compositeReportScenario(host.app);
  const sections=f.types.map((type,i)=>({versionId:type.versionId,name:type.name,fields:type.reportTemplate.fields,...type.evidencePolicy,verificationMode:'dispatcher',verifierId:null,values:{result:i ? 'SN-123' : '-18 dBm'}}));
  host.app.db.prepare("UPDATE work_orders SET status='completed',assignee_worker_id='COMMON-1-W' WHERE id=?").run(f.order.id);
  host.app.db.prepare("INSERT INTO work_reports(id,work_order_id,performer_worker_id,revision,status,comment,field_values_json,submitted_at,created_at,updated_at) VALUES ('REPORT-UI',?,'COMMON-1-W',1,'submitted','Обе работы выполнены',?,'2026-08-20T12:00:00Z','2026-08-20T12:00:00Z','2026-08-20T12:00:00Z')").run(f.order.id,JSON.stringify({schema:1,sections}));
  await page.goto(`${host.origin}/requests?open=${f.order.id}`);
  const dialog=page.getByRole('dialog');
  await dialog.getByText('Уровень сигнала:',{exact:true}).waitFor();await dialog.getByText('Серийный номер:',{exact:true}).waitFor();
  assert.match(await dialog.innerText(),/-18 dBm/);assert.match(await dialog.innerText(),/SN-123/);
});

test('UI-37 OSM adapter draws saved routes, filters and resizes without 2GIS or recalculation',async t=>{
  const page=await pageFor(t);routeComparisonScenario(host.app);
  host.app.db.exec("UPDATE system_settings SET travel_matrix_provider='osrm', optimization_engine='pyvrp' WHERE id=1");
  await host.app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201);
  let tiles=0,twoGis=0,calculations=0;
  page.on('request',request=>{
    if(request.url().includes('2gis'))twoGis++;
    if(request.url().includes('/api/planning')&&request.method()==='POST')calculations++;
  });
  await page.route('https://tile.openstreetmap.org/**',route=>{tiles++;return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});});
  await page.goto(host.origin);
  await page.locator('.planning-map-osm .planning-map-canvas.ready').waitFor();
  const assertVisibleOsmTiles=async()=>{
    assert.equal(await page.locator('.planning-map-surface.leaflet-container').count(),1,'SDK container classes survive React rendering');
    const tile=page.locator('.leaflet-tile-loaded').first();
    await tile.waitFor({state:'visible'});
    const size=await tile.boundingBox();
    assert.equal(size.width,256,'loaded tiles must not collapse under responsive image styles');
    assert.equal(size.height,256);
  };
  await assertVisibleOsmTiles();
  await page.locator('.osm-route-label').filter({hasText:'SECOND'}).waitFor();
  const labels=await page.locator('.osm-route-label').count();
  assert.ok(labels>=5);
  assert.ok(await page.locator('.leaflet-overlay-pane').count());
  assert.ok(await page.locator('.planning-map svg path').count()>=5);
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  await page.locator('.osm-route-label').filter({hasText:'COMMON-2'}).waitFor({state:'hidden'});
  assert.ok(await page.locator('.osm-route-label').count()<labels);
  const selected=page.getByRole('button',{name:/Показать маршрут исполнителя/}).first();
  await selected.click();
  const previousHeight=(await page.locator('.planning-map').boundingBox()).height;
  await page.getByRole('button',{name:'Развернуть карту и исполнителей',exact:true}).click();
  assert.ok((await page.locator('.planning-map').boundingBox()).height>previousHeight);
  await page.getByRole('button',{name:'Увеличить карту',exact:true}).click();
  await assertVisibleOsmTiles();
  assert.ok(await page.locator('.leaflet-control-attribution').isVisible());
  assert.ok(tiles>0);assert.equal(twoGis,0);assert.equal(calculations,0);
});

test('UI-29 an unavailable map shows an unobstructed error and retry loads the SDK again',async t=>{
  const page=await pageFor(t);let attempts=0;
  await page.route('**/api/map-config',route=>route.fulfill({json:{providerId:'2gis',mapKey:'fixture-only'}}));
  await page.route('https://mapgl.2gis.com/api/js/v1',route=>{
    attempts++;
    if(attempts===1)return route.abort();
    return route.fulfill({contentType:'application/javascript',body:`
      (() => {
      class Map {on(event,handler){if(event==='idle')queueMicrotask(handler);}fitBounds(){}setCenter(){}setZoom(){}setControlsLayoutPadding(){}destroy(){}}
      class ObjectOnMap {destroy(){}}
      window.mapgl={Map,Polyline:ObjectOnMap,Label:ObjectOnMap,CircleMarker:ObjectOnMap};
      })();
    `});
  });
  await page.goto(host.origin);
  const retry=page.getByRole('button',{name:'Повторить загрузку',exact:true});await retry.waitFor();
  assert.equal(await page.locator('.stitch-map-legend').count(),0);
  assert.equal(await page.locator('.planning-map-fallback').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
  await retry.click();await page.locator('.planning-map-canvas.ready').waitFor();
  assert.equal(attempts,2);assert.equal(await retry.count(),0);
  await page.locator('.stitch-map-legend').waitFor();
});

test('UI-25 before and after routes draw separately, follow the department filter and survive publication',async t=>{
  const page=await pageFor(t);routeComparisonScenario(host.app);
  await page.route('**/api/map-config',route=>route.fulfill({json:{providerId:'2gis',mapKey:'fixture-only'}}));
  await page.addInitScript(()=>{
    window.testMapObjects=[];window.testMapZooms=[];
    class ObjectOnMap {constructor(map,options){this.options=options;this.kind=this.constructor.name;this.alive=true;window.testMapObjects.push(this);}destroy(){this.alive=false;}}
    class Polyline extends ObjectOnMap {} class Label extends ObjectOnMap {} class CircleMarker extends ObjectOnMap {}
    class Map {zoom=8;on(event,handler){if(event==='idle')queueMicrotask(handler);}fitBounds(){this.zoom=8;}setCenter(){}getZoom(){return this.zoom;}setZoom(zoom){this.zoom=zoom;window.testMapZooms.push(zoom);}setControlsLayoutPadding(){}destroy(){}}
    window.mapgl={Map,Polyline,Label,CircleMarker};
  });
  await page.goto(host.origin);await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  const comparison=page.getByRole('region',{name:'Сравнение маршрутов'});await comparison.waitFor();
  await comparison.getByText(/До и после пересчёта/).click();
  const mapBounds = await page.locator('.planning-map').boundingBox();
  assert.ok(mapBounds.height >= 300, 'Expanded comparison must leave enough height to read the map');
  const columns=comparison.locator('.route-comparison-columns > div');
  assert.deepEqual(await page.evaluate(()=>window.testMapZooms),[], 'Initial zoom must not override fitting all routes');
  assert.equal(await page.locator('.stitch-map-legend').evaluate(el=>el.open),false);
  await page.getByRole('button',{name:'Увеличить карту',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.testMapZooms.at(-1)),9, 'Zoom changes relative to fitted map bounds');
  assert.match(await columns.nth(0).locator('li').first().innerText(),/SECOND/);assert.match(await columns.nth(1).locator('li').first().innerText(),/COMMON-1/);
  await comparison.getByRole('checkbox').check();
  await page.waitForFunction(()=>window.testMapObjects.some(o=>o.alive&&o.kind==='Polyline'&&o.options.color==='#64748baa'));
  const lines=await page.evaluate(()=>window.testMapObjects.filter(o=>o.alive&&o.kind==='Polyline').map(o=>o.options));
  assert.equal(lines.length,3);assert.notDeepEqual(lines[0].coordinates,lines[2].coordinates);
  await comparison.getByRole('checkbox').uncheck();
  await page.waitForFunction(()=>!window.testMapObjects.some(o=>o.alive&&o.options.color==='#64748baa'));
  await page.getByRole('button',{name:'Опубликовать план',exact:true}).click();await page.getByText('План опубликован',{exact:true}).waitFor();
  await page.reload();await comparison.waitFor();await comparison.getByText(/До и после пересчёта/).click();
  assert.match(await comparison.locator('.route-comparison-columns > div').first().locator('li').first().innerText(),/SECOND/);
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-002');await comparison.waitFor({state:'hidden'});
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  await comparison.getByText(/До и после пересчёта/).click();
  host.app.db.exec("UPDATE workers SET active=0 WHERE id='COMMON-1-W'");
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await comparison.getByText('Все заявки сняты.',{exact:true}).waitFor();
  await comparison.getByText(/не подтверждены доступность/).waitFor();
  await page.getByRole('button',{name:/Показать маршрут исполнителя Одинаковая бригада/}).click();
  await comparison.getByText('Все заявки сняты.',{exact:true}).waitFor();
});

test('UI-26 the dispatcher plan marks manual overlap red and clears it for a conflict-free proposal',async t=>{
  const page=await pageFor(t);routeComparisonScenario(host.app);
  host.app.db.exec("UPDATE work_orders SET scheduled_start='2026-08-20T12:10',scheduled_end='2026-08-20T13:10' WHERE id='COMMON-1-J'");
  await page.goto(host.origin);
  const warnings=page.locator('.engineer-stop .schedule-conflict-text').filter({hasText:/Пересечение/});await warnings.first().waitFor();
  assert.equal(await warnings.first().evaluate(el=>getComputedStyle(el).color),'rgb(180, 35, 24)');
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await page.getByRole('region',{name:'Сравнение маршрутов'}).waitFor();
  assert.equal(await warnings.count(),0);
});

test('UI-24 emergency selection fills priority and the regional day window automatically',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  const category=(await host.app.json('/api/admin/work-categories',{method:'POST',body:{name:'Аварийные работы',description:'',active:true}},201)).item;
  await host.app.json('/api/admin/work-types',{method:'POST',body:{name:'Авария',description:'',plannedDurationMinutes:60,verificationMethodId:'dispatcher',requiredSkills:[],requiredQualifications:[],categoryIds:[category.id]}},201);
  await page.goto(`${host.origin}/requests`);
  await page.getByRole('button',{name:/Создать заявку/}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('combobox',{name:/^Тип ВК/}).selectOption(category.id);
  await dialog.getByRole('checkbox',{name:'Авария',exact:true}).check();
  await dialog.getByLabel(/^Плановое начало работ/).fill('2026-08-20T14:00');
  const priority=dialog.getByRole('combobox',{name:/^Приоритет/});assert.equal(await priority.inputValue(),'high');assert.equal(await priority.isDisabled(),true);
  assert.equal(await dialog.getByLabel('Клиентское окно: с',{exact:true}).inputValue(),'2026-08-20T00:00');
  const end=dialog.getByLabel('Клиентское окно: до',{exact:true});assert.equal(await end.inputValue(),'2026-08-20T23:59');assert.equal(await end.getAttribute('readonly'),'');
  await dialog.getByText(/Срочная авария. Окно/).waitFor();
  await dialog.getByRole('combobox',{name:/^Статус/}).selectOption('new');
  await dialog.getByLabel(/^Адрес \*/).fill('Москва, Тестовая улица, 1');
  await dialog.getByText(/Найдено:/).waitFor();
  await dialog.getByRole('button',{name:'Создать заявку',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const created=(await host.app.json('/api/requests')).items.find(item=>item.work==='Авария');
  assert.equal(created.isEmergency,true);assert.equal(created.priority,'high');assert.equal(created.clientWindowStart,'2026-08-20T00:00');
});

test('UI-22 a department filter keeps calculation and publication common, and edits the correct department',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  await page.goto(host.origin);
  const filter=page.getByLabel('Подразделение',{exact:true});
  await filter.selectOption('ORG-001');
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await page.getByRole('button',{name:/Заявка COMMON-1/}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Заявка COMMON-2/}).count(),0);
  const plan=(await host.app.json('/api/planning/group?date=2026-08-20')).result;
  assert.equal(plan.metrics.plannedJobs,2);assert.equal(plan.departments.length,2);
  await page.getByRole('button',{name:'Опубликовать план',exact:true}).click();
  await page.getByText('План опубликован',{exact:true}).waitFor();
  assert.equal(host.app.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE id LIKE 'COMMON-%' AND status='assigned'").get().n,2);
  await filter.selectOption('all');
  await page.getByRole('button',{name:/Заявка COMMON-2/}).waitFor();
  assert.equal(await page.locator('.engineer-card').count(),2);
  for(const card of await page.locator('.engineer-card').all())assert.equal(await card.locator('.engineer-stop').count(),1,'same brigade name must not combine departments');
  await filter.selectOption('ORG-002');
  await page.getByRole('button',{name:/Заявка COMMON-2/}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Описание',{exact:true}).fill('Изменение второго подразделения');
  await dialog.getByRole('button',{name:/Сохранить изменения/}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(host.app.db.prepare("SELECT description FROM work_orders WHERE id='COMMON-2-J'").get().description,'Изменение второго подразделения');
  assert.equal(host.app.db.prepare("SELECT description FROM work_orders WHERE id='COMMON-1-J'").get().description,'');
});

test('UI-36 notification read controls persist without navigation and respect the department filter',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  host.app.db.exec('DELETE FROM dispatcher_notifications; DELETE FROM dispatcher_notification_cursors');
  for(let i=0;i<61;i++) host.app.db.prepare("INSERT INTO dispatcher_notifications(organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001','COMMON-1-J','problem',?,'2026-09-18T10:00:00Z')").run(`Уведомление ${i}`);
  host.app.db.exec("INSERT INTO dispatcher_notifications(organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-002','COMMON-2-J','problem','Другое подразделение','2026-09-18T10:00:00Z')");
  await page.goto(host.origin);
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  await page.getByRole('button',{name:'Уведомления: 61 непрочитанных',exact:true}).click();
  const journal=page.getByRole('dialog',{name:'Журнал уведомлений'});
  await journal.getByRole('button',{name:/^Отметить прочитанным:/}).first().click();
  await page.getByRole('button',{name:'Уведомления: 60 непрочитанных',exact:true}).waitFor();
  assert.equal(await journal.getByText('Прочитано',{exact:true}).count(),1);
  await journal.getByRole('button',{name:'Прочитать все',exact:true}).click();
  await page.getByRole('button',{name:'Уведомления',exact:true}).waitFor();
  assert.equal(await journal.getByRole('button',{name:/^Отметить прочитанным:/}).count(),0);
  await journal.getByRole('button',{name:'Ранее',exact:true}).click();
  await journal.getByText('Уведомление 0',{exact:true}).waitFor();
  assert.equal(await journal.getByText('Прочитано',{exact:true}).count(),61);
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal((await host.app.json('/api/notifications',{headers:{'X-MMI-Organization':'ORG-002'}})).unread,1);
  await page.reload();
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  await page.getByRole('button',{name:'Уведомления',exact:true}).click();
  await journal.getByText('Уведомление 60',{exact:true}).waitFor();
  assert.equal(await journal.getByRole('button',{name:/^Отметить прочитанным:/}).count(),0);
});

test('UI-23 notifications follow the visible departments and open the correct request',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  host.app.db.exec('DELETE FROM dispatcher_notifications; DELETE FROM dispatcher_notification_cursors');
  const initialized=page.waitForResponse(r=>r.url().endsWith('/api/notifications')&&r.request().method()==='PUT'&&r.request().headers()['x-mmi-organization']==='ORG-002');
  await page.goto(host.origin);const filter=page.getByLabel('Подразделение',{exact:true});
  await initialized;
  await filter.selectOption('ORG-001');
  host.app.db.prepare("INSERT INTO dispatcher_notifications(organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-002','COMMON-2-J','problem','Нет доступа во втором подразделении',?)").run(new Date().toISOString());
  await page.getByRole('button',{name:/^Уведомления/}).click();
  assert.equal(await page.getByRole('dialog',{name:'Журнал уведомлений'}).getByText(/Нет доступа во втором/).count(),0);
  await filter.selectOption('all');
  const toast=page.locator('.dispatcher-event-toast');await toast.getByText('Нет доступа во втором подразделении',{exact:true}).waitFor();
  await toast.getByRole('button').click();
  await page.waitForURL('**/requests?open=COMMON-2-J');
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator('.dispatcher-organization-select select').inputValue(),'ORG-002');
});

const require = createRequire(import.meta.url);
// Standard installed playwright, or a preinstalled runtime module supplied by
// the test operator. No automatic downloads or dependency on a user's profile.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
let host, browser;
const artifactDir = fileURLToPath(new URL("../.tmp/qa-browser/", import.meta.url));
before(async () => {
  host = await startBrowserServer();
  browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  await mkdir(artifactDir, { recursive: true });
});
after(async () => { await browser?.close(); await host?.close(); });

async function pageFor(t, { signedIn = true, width = 1294 } = {}) {
  host.app.db.exec("SAVEPOINT browser_scenario");
  const context = await browser.newContext({ viewport: { width, height: 912 }, locale: "ru-RU", timezoneId: "Europe/Moscow" });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === host.origin ? route.continue() : route.abort());
  if (signedIn) await context.addCookies([{ name: "mmi_session", value: host.app.cookie.split("=")[1], url: host.origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    if (!page.isClosed()) await page.screenshot({ path: `${artifactDir}/${t.name.split(" ")[0]}.png`, fullPage: false });
    await context.close();
    host.app.db.exec("ROLLBACK TO browser_scenario; RELEASE browser_scenario");
    assert.deepEqual(errors, [], "unhandled browser errors");
  });
  return page;
}

test("UI-01 login succeeds on the first attempt and remains signed in after reload", async (t) => {
  const page = await pageFor(t, { signedIn: false });
  let posts = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/auth/login") && r.method() === "POST") posts++; });
  await page.goto(`${host.origin}/login`);
  await page.locator('input[type="email"]').fill("qa@example.invalid");
  await page.locator('input[type="password"]').fill("isolated-test-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("heading", { name: "Планирование выездов" }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Планирование выездов" }).waitFor();
  assert.equal(posts, 1);
});

test("UI-02 unified catalog saves a VK and preserves Cyrillic after reload", async (t) => {
  const page = await pageFor(t, { width: 997 });
  await page.goto(host.origin+"/admin");
  await page.getByRole("tab",{name:"Типы заявок",exact:true}).click();
  assert.deepEqual(await page.getByRole("tablist").getByRole("tab").allTextContents(),["Настройки","Пользователи","Роли","Типы заявок"]);
  assert.equal(await page.getByText("Настройки ВК и оборудование",{exact:true}).count(),0);
  await page.getByRole("button",{name:"Добавить тип ВК",exact:true}).click();
  await page.getByLabel("Название ВК",{exact:true}).fill("Наладка счётчиков Ёё");
  await page.getByLabel("Описание",{exact:true}).fill("Проверка кириллицы: щ, ъ, ы, ю, я.");
  await page.getByRole("button",{name:"Сохранить ВК",exact:true}).click();
  await page.getByRole("dialog").waitFor({state:"hidden"});
  await page.reload();await page.getByRole("tab",{name:"Типы заявок",exact:true}).click();
  await page.locator('.work-types-category-filter select').selectOption({label:"Наладка счётчиков Ёё"});
  await page.getByRole("button",{name:"Редактировать ВК",exact:true}).click();
  assert.equal(await page.getByLabel("Описание",{exact:true}).inputValue(),"Проверка кириллицы: щ, ъ, ы, ю, я.");
});

test("UI-30 shared catalog starts with VK, opens HD and persists automatic acceptance across divisions", async (t) => {
  const page=await pageFor(t,{width:1011}),categories=[];
  for(const name of ['Глобальная проблема','Локальная заявка','Дозаказ','Подключение'])categories.push((await host.app.json('/api/admin/work-categories',{method:'POST',body:{name,description:'',active:true}},201)).item);
  const type=(await host.app.json('/api/admin/work-types',{method:'POST',body:{name:'Подключение тестового абонента',description:'',categoryIds:[categories[3].id],plannedDurationMinutes:70,verificationMethodId:'dispatcher',requiredSkills:[],requiredQualifications:[]}},201)).item;
  await page.goto(`${host.origin}/admin`);
  await page.getByRole('tab',{name:'Типы заявок',exact:true}).click();
  const filter=page.locator('.work-types-category-filter select');
  assert.deepEqual(await filter.locator('option').allTextContents(),['Подключение','Дозаказ','Локальная заявка','Глобальная проблема','Без ВК']);
  await page.getByRole('button',{name:`Редактировать тип HD ${type.name}`,exact:true}).click();
  const dialog=page.getByRole('dialog');
  const sections=await dialog.locator('.work-type-editor-fields > section > h3').allTextContents();
  assert.equal(sections[0],'1. Тип ВК');assert.match(sections[1],/Конкретная работа \(HD\)/);
  await dialog.getByLabel('Тип проверки',{exact:false}).selectOption('automatic');
  await dialog.getByRole('button',{name:'Сохранить изменения',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.locator('.work-types-table').getByText('Принимать автоматически',{exact:false}).waitFor();
  await page.locator('.dispatcher-organization-select select').selectOption('ORG-002');
  await page.getByRole('tab',{name:'Типы заявок',exact:true}).click();
  await page.getByRole('button',{name:`Редактировать тип HD ${type.name}`,exact:true}).click();
  assert.equal(await dialog.getByLabel('Тип проверки',{exact:false}).inputValue(),'automatic');
});

test("UI-03 switching organization clears old requests and returning restores them", async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/requests`);
  await page.locator(".request-row").first().waitFor();
  const selector = page.locator(".dispatcher-organization-select select");
  await selector.selectOption("ORG-002");
  await page.getByText("Заявки с выбранным статусом не найдены", { exact: true }).waitFor();
  assert.equal(await page.locator(".request-row").count(), 0);
  await page.locator(".dispatcher-organization-select select").selectOption("ORG-001");
  await page.locator(".request-row").first().waitFor();
});

test("UI-04 map stays within the viewport and engineer list scrolls after resizing", async (t) => {
  const page = await pageFor(t);
  await page.goto(host.origin);
  await page.getByLabel("Дата планирования").fill("2026-08-20");
  await page.locator(".engineer-card").first().waitFor();
  for (const width of [1294, 997, 1440]) {
    await page.setViewportSize({ width, height: 912 });
    const box = await page.locator(".planning-map").boundingBox();
    assert.ok(box && box.height > 200 && box.y + box.height <= 914, `map bounds at ${width}: ${JSON.stringify(box)}`);
    const overflow = await page.locator(".engineer-cards").evaluate((element) => getComputedStyle(element).overflowY);
    assert.ok(["auto", "scroll"].includes(overflow), `engineer cards overflow=${overflow}`);
  }
});

test("UI-05 changing the planning day reloads assigned and unassigned jobs without recalculation", async (t) => {
  const page = await pageFor(t);
  commonScenario(host.app);
  host.app.db.exec("UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W' WHERE id='COMMON-1-J'");
  let calculations = 0;
  page.on('request', request => { if (request.method()==='POST' && request.url().includes('/api/planning')) calculations++; });
  await page.goto(host.origin);
  await page.locator('.engineer-card').getByText('Заявка COMMON-1',{exact:true}).waitFor();
  // Change the DB after the initial load: switching date must not use the old cache.
  host.app.db.exec("UPDATE work_orders SET scheduled_start='2026-08-21T12:00',scheduled_end='2026-08-21T13:00' WHERE id IN ('COMMON-1-J','COMMON-2-J')");
  const reload = page.waitForResponse(response => response.url().endsWith('/api/planning/workspace?date=2026-08-21'));
  await page.getByLabel('Дата планирования').fill('2026-08-21');
  const payload = await (await reload).json();
  assert.ok(payload.items.length>=2);
  assert.ok(payload.items.every(item=>item.dateTime.startsWith('2026-08-21')));
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  await page.locator('.engineer-card').getByText('Заявка COMMON-1',{exact:true}).waitFor();
  await page.getByText('Общая работа · COMMON-2',{exact:true}).waitFor();
  assert.equal(await page.locator('.stitch-metrics article').nth(0).locator('strong').innerText(),'2');
  assert.match(await page.locator('.stitch-metrics article').nth(1).locator('strong').innerText(),/^1\s*\/ 2$/);
  // Paused work on another date must not leak into an empty selected day.
  host.app.db.exec("UPDATE work_orders SET status='paused' WHERE id='COMMON-1-J'");
  await page.getByLabel('Дата планирования').fill('2026-08-22');
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.engineer-card').getByText(/Заявка /).count(),0);
  assert.equal(await page.locator('.stitch-metrics article').nth(0).locator('strong').innerText(),'0');
  assert.equal(await page.getByText('Общая работа · COMMON-2',{exact:true}).count(),0);
  await page.getByLabel('Дата планирования').fill('2026-08-21');
  await page.locator('.engineer-card').getByText('Заявка COMMON-1',{exact:true}).waitFor();
  // A response from a date left behind must not replace the newly selected day.
  let release, entered, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { entered = resolve; });
  const done = new Promise(resolve => { finished = resolve; });
  await page.route('**/api/planning/workspace?date=2026-08-20', async route => {
    entered();
    await gate;
    try { await route.fulfill({json:{...payload,items:payload.items.map(item=>({...item,dateTime:item.dateTime.replace('2026-08-21','2026-08-20')}))}}); }
    catch { /* The obsolete request is expected to be aborted. */ }
    finally { finished(); }
  });
  await page.getByLabel('Дата планирования').fill('2026-08-20');
  await received;
  await page.getByLabel('Дата планирования').fill('2026-08-22');
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  release(); await done;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByLabel('Дата планирования').inputValue(),'2026-08-22');
  assert.equal(await page.locator('.engineer-card').getByText(/Заявка /).count(),0);
  assert.equal(await page.locator('.stitch-metrics article').nth(0).locator('strong').innerText(),'0');
  assert.equal(calculations,0);
});


test("UI-06 reports apply actual completion period, show pie and export matching CSV", async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/reports`);
  await page.getByLabel("Период отчёта").selectOption("custom");
  await page.getByLabel("С", { exact: true }).fill("2026-08-01");
  await page.getByLabel("По (включительно)", { exact: true }).fill("2026-08-31");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("img", { name: /Круговая диаграмма.*Всего выполнено заявок: 1/ }).waitFor();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /Экспорт CSV/ }).click();
  const download = await downloaded;
  assert.match(download.suggestedFilename(), /ORG-001-2026-08-01-2026-08-31/);
  const csv = await readFile(await download.path(), "utf8");
  assert.ok(csv.includes("ORD-9018"));
  assert.ok(!csv.includes("A-1428"), "assigned order must not appear as completed");
  await page.getByLabel("С", { exact: true }).fill("2026-08-21");
  await page.getByLabel("По (включительно)", { exact: true }).fill("2026-08-21");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("heading", { name: "Нет выполненных заявок за выбранный период" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Экспорт CSV/ }).isDisabled(), true);
});

test("UI-07 request editor keeps latitude and longitude read-only", async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/requests`);
  await page.locator(".request-row").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  for (const label of [/Широта/, /Долгота/]) {
    assert.equal(await dialog.getByLabel(label).evaluate((input) => input.readOnly), true);
  }
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
});

test("UI-08 customer window and access details persist after changing planned time in the form", async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/requests`);
  const row = () => page.locator(".request-row").filter({ hasText: "ORD-9021" });
  await row().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Клиентское окно: с", { exact: true }).fill("2026-08-24T08:00");
  await dialog.getByLabel("Клиентское окно: до", { exact: true }).fill("2026-08-24T11:00");
  await dialog.getByLabel(/^Плановое начало работ/u).fill("2026-08-24T09:30");
  await dialog.getByLabel("Квартира / офис", { exact: true }).fill("12А");
  await dialog.getByLabel("Подъезд", { exact: true }).fill("2");
  await dialog.getByLabel("Домофон", { exact: true }).fill("12#К");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await row().click();
  assert.equal(await dialog.getByLabel("Клиентское окно: с", { exact: true }).inputValue(), "2026-08-24T08:00");
  assert.equal(await dialog.getByLabel("Клиентское окно: до", { exact: true }).inputValue(), "2026-08-24T11:00");
  assert.equal(await dialog.getByLabel(/^Плановое начало работ/u).inputValue(), "2026-08-24T09:30");
  assert.equal(await dialog.getByLabel("Квартира / офис", { exact: true }).inputValue(), "12А");
  assert.equal(await dialog.getByLabel("Домофон", { exact: true }).inputValue(), "12#К");
});

test("UI-09 catalog form persists BK and equipment; a composite job shows every HD and its shared norm", async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/admin`);
  await page.getByRole("tab", { name: "Типы заявок", exact: true }).click();
  await page.getByRole("button",{name:"Добавить тип ВК",exact:true}).click();
  await page.getByLabel("Название ВК", { exact: true }).fill("Домашний интернет");
  await page.getByRole("spinbutton", { name: "Норматив ВК без дороги, мин", exact: true }).fill("70");
  assert.equal(await page.getByRole("textbox", { name: "Источник норматива", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Сохранить ВК", exact: true }).click();
  await page.getByRole("dialog").waitFor({state:"hidden"});
  await page.locator(".work-types-category-filter select").selectOption({label:"Домашний интернет"});
  await page.getByRole("button", {name:"Редактировать ВК",exact:true}).click();
  assert.equal(await page.getByRole("spinbutton", { name: "Норматив ВК без дороги, мин", exact: true }).inputValue(), "70");
  await page.getByRole("spinbutton", { name: "Норматив ВК без дороги, мин", exact: true }).fill("80");
  await page.getByRole("button", { name: "Сохранить ВК", exact: true }).click();
  await page.getByRole("dialog").waitFor({state:"hidden"});
  await page.getByRole("button", {name:"Оборудование ВК",exact:true}).click();
  await page.getByRole("button", {name:"Новое оборудование",exact:true}).click();
  await page.getByLabel("Название оборудования", { exact: true }).fill("Роутер");
  await page.getByLabel("Единица измерения", { exact: true }).fill("шт.");
  await page.getByLabel("Использование", { exact: true }).selectOption("consumable");
  await page.getByRole("button", { name: "Сохранить оборудование", exact: true }).click();
  await page.getByLabel("Количество: Роутер",{exact:true}).fill("1");
  await page.getByRole("button",{name:"Сохранить список оборудования",exact:true}).click();
  await page.getByRole("dialog").waitFor({state:"hidden"});
  const bootstrap = await host.app.json("/api/admin/bootstrap");
  const category = bootstrap.workCategories.find(item => item.name === "Домашний интернет");
  assert.equal(category.serviceDurationMinutes, 80);
  assert.equal(category.durationSource, "Норматив ВК");
  const equipment = bootstrap.equipmentItems.find(item => item.name === "Роутер");
  const types = [];
  for (const name of ["Подключение оптики", "Дозаказ роутера"]) {
    types.push((await host.app.json("/api/admin/work-types", { method: "POST", body: { name, description: "", plannedDurationMinutes: 70, verificationMethodId: "dispatcher", requiredSkills: [], requiredQualifications: [], categoryIds: [category.id], equipmentRequirements: [{ equipmentId: equipment.id, quantity: 1 }] } }, 201)).item);
  }
  await page.goto(`${host.origin}/requests`);
  await page.getByRole("button", { name: "Создать заявку", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: /^Тип ВК/ }).selectOption(category.id);
  await dialog.getByLabel("Подключение оптики", { exact: true }).check();
  await dialog.getByLabel("Дозаказ роутера", { exact: true }).check();
  await dialog.getByLabel("Общий норматив обслуживания, мин *", { exact: true }).fill("80");
  await dialog.getByLabel("Источник общего норматива *", { exact: true }).fill("Согласованный норматив");
  await dialog.getByRole("combobox", { name: /^Приоритет/ }).selectOption("medium");
  await dialog.getByRole("combobox", { name: /^Статус/ }).selectOption("new");
  await dialog.getByLabel(/^Плановое начало работ/u).fill("2026-08-25T10:00");
  await dialog.getByLabel("Клиентское окно: с", { exact: true }).fill("2026-08-25T09:00");
  await dialog.getByLabel("Клиентское окно: до", { exact: true }).fill("2026-08-25T12:00");
  await dialog.getByLabel(/^Адрес \*/).fill("Москва, Тестовая, 1");
  await dialog.getByText(/Найдено:/).waitFor();
  await dialog.getByRole("button", { name: "Создать заявку", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await page.locator(".request-row").filter({ hasText: "Подключение оптики + Дозаказ роутера" }).click();
  assert.equal(await dialog.getByLabel("Общий норматив обслуживания, мин *", { exact: true }).inputValue(), "80");
  assert.equal(await dialog.getByLabel("Дозаказ роутера", { exact: true }).isChecked(), true);
  await dialog.getByText("Роутер — 1 шт.", { exact: true }).waitFor();
});

test("UI-10 status toast lasts ten seconds, journal survives reload and opens the request", async (t) => {
  const page = await pageFor(t);
  const initialized = page.waitForResponse(response => response.url().endsWith("/api/notifications") && response.request().method() === "PUT");
  await page.goto(`${host.origin}/requests`);
  await page.locator(".request-row").first().waitFor();
  await initialized;
  host.app.db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'");
  const toast = page.locator(".dispatcher-event-toast");
  await toast.waitFor();
  const shown = Date.now();
  await toast.waitFor({ state: "hidden", timeout: 13000 });
  assert.ok(Date.now() - shown >= 9000, "toast should remain visible for approximately ten seconds");
  await page.reload();
  await page.getByRole("button", { name: /^Уведомления/ }).click();
  const journal = page.getByRole("dialog", { name: "Журнал уведомлений" });
  await journal.getByRole("button", { name: /ORD-9021 · Назначена/ }).click();
  await page.getByRole("dialog", { name: "Редактирование заявки" }).waitFor();
  await page.getByRole("dialog", { name: "Редактирование заявки" }).getByText("#ORD-9021", { exact: true }).waitFor();
  assert.equal((await host.app.json("/api/notifications")).items[0].read, true);
});

test("UI-11 manual overlap is red before saving and the manual assignment reason survives reload", async (t) => {
  const page = await pageFor(t);
  const data = await host.app.json("/api/requests");
  const source = data.items.find(item => item.assigneeId && item.status === "assigned");
  const create = async time => (await host.app.json("/api/requests", { method: "POST", body: {
    work: source.work, description: "Ручная проверка", priority: "medium", status: "assigned", dateTime: time, address: source.address, assignee: source.assignee, assigneeId: source.assigneeId,
  } }, 201)).item;
  const a = await create("2026-08-27T10:00");
  const b = await create("2026-08-27T15:00");
  await page.goto(`${host.origin}/requests?open=${b.id}`);
  const dialog = page.getByRole("dialog", { name: "Редактирование заявки" });
  await dialog.getByLabel(/^Плановое начало работ/u).fill("2026-08-27T10:10");
  const warning = dialog.getByRole("alert", { name: "Пересечения работ" });
  await warning.waitFor();
  assert.ok((await warning.innerText()).includes(a.number));
  assert.ok(!(await warning.innerText()).includes(a.id));
  assert.equal(await warning.evaluate(element => getComputedStyle(element).color), "rgb(180, 35, 24)");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await dialog.waitFor();
  await dialog.getByText(/Назначена вручную:/).waitFor();
  await dialog.getByText("Диспетчер изменил плановое время работ.", { exact: true }).waitFor();
  await dialog.getByRole("alert", { name: "Пересечения работ" }).waitFor();
  let calculations=0;
  page.on('request',request=>{if(request.url().includes('/api/planning') && request.method()==='POST') calculations++;});
  const before=host.app.db.prepare('SELECT id,status,assignee_worker_id,scheduled_start FROM work_orders ORDER BY id').all();
  await page.goto(host.origin);
  await page.getByLabel('Дата планирования').fill('2026-08-27');
  const tasks=page.getByRole('region',{name:new RegExp(`^Задачи исполнителя ${source.assignee}`)});
  await tasks.getByRole('button',{name:new RegExp(`Заявка ${a.number}`)}).waitFor();
  const selector=page.getByRole('button',{name:new RegExp(`^Показать маршрут исполнителя ${source.assignee}`)});
  await selector.click();
  assert.equal(await selector.getAttribute('aria-pressed'),'true');
  await tasks.getByRole('button',{name:new RegExp(`Заявка ${b.number}`)}).waitFor();
  assert.ok(await tasks.locator('.schedule-conflict-text').count()>=2);
  assert.equal(await tasks.locator('.schedule-conflict-text').first().evaluate(element=>getComputedStyle(element).color),'rgb(180, 35, 24)');
  await selector.click();
  assert.equal(await selector.getAttribute('aria-pressed'),'false');
  assert.equal(calculations,0,'selecting a brigade only displays existing assignments');
  assert.deepEqual(host.app.db.prepare('SELECT id,status,assignee_worker_id,scheduled_start FROM work_orders ORDER BY id').all(),before);
});

test("UI-13 a removed assignment remains visible on an emptied route after publication and reload", async (t) => {
  const page = await pageFor(t);
  host.app.db.exec(`UPDATE work_orders SET status='cancelled';
    UPDATE work_orders SET status='assigned',scheduling_timezone='Europe/Moscow',client_window_start='2026-08-20T09:00:00+03:00',client_window_end='2026-08-20T17:00:00+03:00' WHERE id='A-1428';
    UPDATE workers SET active=0;
    UPDATE workers SET active=1,shift_status='on_shift',transport_mode='car',work_schedule_id=(SELECT work_schedule_id FROM workers WHERE id='EMP-402') WHERE id='EMP-390';
    INSERT OR IGNORE INTO worker_skills (worker_id,skill_id) SELECT 'EMP-390',skill_id FROM worker_skills WHERE worker_id='EMP-402';
    INSERT OR IGNORE INTO worker_qualifications (worker_id,qualification_id,status) SELECT 'EMP-390',qualification_id,'valid' FROM worker_qualifications WHERE worker_id='EMP-402';`);
  await host.app.json("/api/admin/settings", { method: "PUT", body: { appName: "Марш!", timezone: "Europe/Moscow", emailAlerts: true, weeklyDigest: false, optimizationEngine: "pyvrp", travelMatrixProvider: "osrm" } });
  const { result } = await host.app.json("/api/planning/group", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201);
  await page.goto(host.origin);
  const removed = page.locator(".removed-assignments");
  await removed.getByRole("button", { name: /Снята:/ }).waitFor();
  assert.match(await removed.innerText(), /Прежний исполнитель недоступен/);
  assert.equal(await removed.locator(".engineer-stop").count(), 0);
  await page.getByRole("button", { name: "Опубликовать план", exact: true }).click();
  await page.getByText("План опубликован", { exact: true }).waitFor();
  await page.reload();
  await removed.getByRole("button", { name: /Снята:/ }).waitFor();
  await page.locator(".engineer-cards").getByText(/Перенесена с Алексей Иванов/).waitFor();
  assert.equal((await host.app.json("/api/planning/group?date=2026-08-20")).result.metrics.totalDistanceKm, result.metrics.totalDistanceKm);
});

test("UI-34 saved global source stays identical after switching departments and appears on the dashboard",async t=>{
  const page=await pageFor(t);
  await page.goto(host.origin+'/admin');
  await page.getByRole('tab',{name:'Настройки',exact:true}).click();
  const settings=page.getByRole('region',{name:'Настройки планирования',exact:true});
  await settings.getByLabel(/^Максимальное время расчёта/).fill('420');
  assert.equal(await settings.getByLabel('Название приложения',{exact:true}).count(),0);
  await settings.getByLabel(/^Алгоритм распределения/).selectOption('ortools');
  await settings.getByLabel(/^Источник времени и расстояний/).selectOption('osrm');
  await settings.getByLabel(/^Приоритет аварий и штата/).selectOption('emergency_staff/v1');
  const save=page.waitForResponse(r=>r.url().endsWith('/api/admin/settings') && r.request().method()==='PUT');
  await settings.getByRole('button',{name:'Сохранить',exact:true}).click();assert.equal((await save).status(),200);
  await page.locator('.dispatcher-organization-select select').selectOption('ORG-002');
  await page.getByRole('tab',{name:'Настройки',exact:true}).click();
  assert.equal(await settings.getByLabel(/^Алгоритм распределения/).inputValue(),'ortools');
  assert.equal(await settings.getByLabel(/^Источник времени и расстояний/).inputValue(),'osrm');
  assert.equal(await settings.getByLabel(/^Максимальное время расчёта/).inputValue(),'420');
  await settings.getByLabel(/^Максимальное время расчёта/).fill('600');
  await settings.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.equal(await settings.getByLabel(/^Максимальное время расчёта/).inputValue(),'420');
  assert.equal(await settings.getByLabel(/^Приоритет аварий и штата/).inputValue(),'emergency_staff/v1');
  await page.goto(host.origin);
  await page.getByText('Общий источник времени и расстояний: OSRM / OpenStreetMap (без пробок).',{exact:true}).waitFor();
});

for (const engineId of ['ortools','pyvrp']) {
test(`UI-14 ${engineId} selection and emergency policy persist; cancel restores saved settings`, async (t) => {
  const page = await pageFor(t);
  await page.goto(`${host.origin}/admin`);
  assert.equal(await page.getByRole("tab", { name: "Настройки", exact: true }).getAttribute('aria-selected'), 'true');
  const settings = page.getByRole("region", { name: "Настройки планирования", exact: true });
  const engine = settings.getByLabel(/^Алгоритм распределения/);
  assert.deepEqual(await engine.locator('option').allTextContents(), ['PyVRP','OR-Tools Routing','2ГИС TSP/VRP']);
  await engine.selectOption(engineId);
  const policy = settings.getByLabel(/^Приоритет аварий и штата/);
  await policy.selectOption("emergency_staff/v1");
  const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/settings") && r.request().method() === "PUT");
  await settings.getByRole("button", { name: "Сохранить", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.reload();
  assert.equal(await page.getByRole("tab", { name: "Настройки", exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await engine.inputValue(), engineId);
  assert.equal(await policy.inputValue(), "emergency_staff/v1");
  await policy.selectOption("emergency_fast/v1");
  await settings.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(await policy.inputValue(), "emergency_staff/v1");
  assert.equal((await host.app.json("/api/admin/bootstrap")).settings.optimizerPolicy, "emergency_staff/v1");
});

}

test("UI-35 department and planning cards save and cancel independently", async t => {
  const page = await pageFor(t);
  await page.goto(host.origin + '/admin');
  await page.getByRole('tab', {name:'Настройки',exact:true}).click();
  const department = page.getByRole('region', {name:'Настройки подразделения',exact:true});
  const planning = page.getByRole('region', {name:'Настройки планирования',exact:true});
  const timezone = department.getByLabel(/^Часовой регион подразделения/);
  const originalTimezone = await timezone.inputValue();
  const changedTimezone = originalTimezone === 'Europe/Samara' ? 'Europe/Moscow' : 'Europe/Samara';
  const engine = planning.getByLabel(/^Алгоритм распределения/);
  const originalEngine = await engine.inputValue();
  const changedEngine = originalEngine === 'ortools' ? 'pyvrp' : 'ortools';
  for (const name of ['Уведомления по email','Еженедельный дайджест']) assert.equal(await page.getByLabel(name,{exact:true}).count(),0);
  await timezone.selectOption(changedTimezone);
  await engine.selectOption(changedEngine);
  await department.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.equal(await timezone.inputValue(),originalTimezone);
  assert.equal(await engine.inputValue(),changedEngine);
  await timezone.selectOption(changedTimezone);
  const saveDepartment = page.waitForResponse(r => r.url().endsWith('/api/admin/settings') && r.request().method() === 'PUT');
  await department.getByRole('button',{name:'Сохранить',exact:true}).click();
  assert.equal((await saveDepartment).status(),200);
  await page.getByText('Настройки подразделения сохранены.',{exact:true}).waitFor();
  let loaded = await host.app.json('/api/admin/bootstrap');
  assert.equal(loaded.settings.timezone,changedTimezone);
  assert.equal(loaded.settings.optimizationEngine,originalEngine);
  await planning.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.equal(await engine.inputValue(),originalEngine);
  assert.equal(await timezone.inputValue(),changedTimezone);
  await timezone.selectOption(originalTimezone);
  await engine.selectOption(changedEngine);
  const savePlanning = page.waitForResponse(r => r.url().endsWith('/api/admin/settings') && r.request().method() === 'PUT');
  await planning.getByRole('button',{name:'Сохранить',exact:true}).click();
  assert.equal((await savePlanning).status(),200);
  await page.getByText('Настройки планирования сохранены для всех подразделений.',{exact:true}).waitFor();
  loaded = await host.app.json('/api/admin/bootstrap');
  assert.equal(loaded.settings.timezone,changedTimezone);
  assert.equal(loaded.settings.optimizationEngine,changedEngine);
  await department.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.equal(await timezone.inputValue(),changedTimezone);
  await page.reload();
  await page.getByRole('tab',{name:'Настройки',exact:true}).click();
  assert.equal(await timezone.inputValue(),changedTimezone);
  assert.equal(await engine.inputValue(),changedEngine);
});

test("UI-15 dispatcher saves regional availability and sees it become stale after the protected job changes",async t=>{
  const page=await pageFor(t);
  host.app.db.exec("UPDATE work_orders SET status='in_progress' WHERE id='A-1428'");
  const worker=(await host.app.json("/api/engineers")).items.find(w=>w.id==='EMP-402');
  await page.goto(`${host.origin}/engineers`);
  await page.getByRole('button',{name:`Редактировать: ${worker.name}`,exact:true}).click();
  const panel=page.getByRole('region',{name:'Доступность для перепланирования',exact:true});
  await page.getByText("Уточнить время и место освобождения",{exact:true}).click();
  await panel.getByLabel(/^Свободен с/).fill('2026-08-20T14:00');
  await panel.getByLabel('Адрес продолжения маршрута',{exact:true}).fill('Москва, Тестовая, 1');
  await panel.getByRole('button',{name:'Сохранить доступность',exact:true}).click();
  await panel.getByText('Оценка сохранена. Пересчитайте план.',{exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
  host.app.db.exec("UPDATE work_orders SET status='paused' WHERE id='A-1428'");
  await page.getByRole('button',{name:`Редактировать: ${worker.name}`,exact:true}).click();
  await page.getByText("Уточнить время и место освобождения",{exact:true}).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByLabel(/^Свободен с/).inputValue(),'2026-08-20T14:00');
  await panel.getByRole('button',{name:'Сохранить доступность',exact:true}).click();
  await panel.getByText('Оценка сохранена. Пересчитайте план.',{exact:true}).waitFor();
  assert.equal((await host.app.json('/api/engineers/availability?workerId=EMP-402')).estimate.stale,false);
});

test("UI-16 recalculation keeps protected work visible and labels the remaining queue",async t=>{
  const page=await pageFor(t);
  host.app.db.exec(`UPDATE work_orders SET status='cancelled'; UPDATE work_orders SET status='in_progress' WHERE id='A-1428';
    UPDATE work_orders SET status='new',assignee_worker_id=NULL,scheduled_start='2026-08-20T10:00',client_window_start='2026-08-20T06:00:00Z',client_window_end='2026-08-20T14:00:00Z' WHERE id='ORD-9021';
    UPDATE workers SET active=0 WHERE id<>'EMP-402';`);
  await host.app.json('/api/admin/settings',{method:'PUT',body:{appName:'Марш!',timezone:'Europe/Moscow',emailAlerts:true,weeklyDigest:false,optimizationEngine:'pyvrp',travelMatrixProvider:'osrm'}});
  await page.goto(host.origin);
  await page.getByLabel('Дата планирования').fill('2026-08-20');
  await page.getByLabel('Время перепланирования').fill('11:00');
  let finishWaiting;
  const waiting = new Promise(resolve => { finishWaiting = resolve; });
  t.after(() => finishWaiting());
  await page.route('**/api/planning/group', async route => {
    if (route.request().method() === 'POST') await waiting;
    await route.continue();
  });
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await page.getByText(/Расчёт выполняется · [1-9]\d* с\./).waitFor();
  assert.equal(await page.getByRole('button',{name:'Расчёт…',exact:true}).isEnabled(),false);
  finishWaiting();
  await page.getByText(/В работе · сохранена при перепланировании/).waitFor();
  await page.getByText(/Защищено заявок: 1/).waitFor();
  assert.equal((await host.app.json('/api/planning?date=2026-08-20')).result.planningAt,'2026-08-20T08:00:00.000Z');
});

test("UI-17 transport follows the vehicle resource and has no separate pedestrian or cycling choice",async t=>{
  const page=await pageFor(t);
  const worker=(await host.app.json('/api/engineers')).items.find(w=>w.id==='EMP-402');
  await page.goto(`${host.origin}/engineers`);
  const open=()=>page.getByRole('button',{name:`Редактировать: ${worker.name}`,exact:true}).click();
  await open();
  const dialog=page.getByRole('dialog');
  const select=dialog.getByRole('combobox',{name:'Госномер',exact:true});
  await select.waitFor();
  assert.equal(await dialog.getByRole('combobox',{name:/^Тип транспорта/}).count(),0);
  await select.selectOption('');
  assert.equal(await dialog.getByLabel('Способ передвижения',{exact:true}).inputValue(),'Общественный транспорт + пешком');
  await dialog.getByRole('button',{name:/Сохранить изменения/}).click();
  await dialog.waitFor({state:'hidden'});
  await page.reload();await open();
  assert.equal(await select.inputValue(),'');
  assert.equal(await dialog.getByLabel('Способ передвижения',{exact:true}).inputValue(),'Общественный транспорт + пешком');
});

test("UI-18 manual edits to a confirmed appointment require an explicit checkbox for the exact change",async t=>{
  const page=await pageFor(t);
  host.app.db.exec("UPDATE work_orders SET client_visit_confirmed=1 WHERE id='ORD-9021'");
  await page.goto(`${host.origin}/requests`);
  await page.getByRole('button',{name:'Редактировать заявку ORD-9021',exact:true}).click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Время визита подтверждено клиенту',{exact:true}).isChecked(),true);
  const start=dialog.getByLabel(/^Плановое начало работ/);
  await start.fill('2026-08-20T15:00');
  const save=dialog.getByRole('button',{name:/Сохранить изменения/});
  assert.equal(await save.isDisabled(),true);
  const ack=dialog.getByLabel('Я сообщил клиенту об этих изменениях',{exact:true});
  await ack.check();assert.equal(await save.isEnabled(),true);
  await start.fill('2026-08-20T16:00');assert.equal(await ack.isChecked(),false);assert.equal(await save.isDisabled(),true);
  await ack.check();await save.click();await dialog.waitFor({state:'hidden'});
  await page.reload();await page.getByRole('button',{name:'Редактировать заявку ORD-9021',exact:true}).click();
  await dialog.getByText(/Диспетчер подтвердил, что сообщил клиенту/).waitFor();
});

test("UI-19 pending client changes stay visible after reload, block publication, and become audited only when published",async t=>{
  const page=await pageFor(t);
  host.app.db.exec(`UPDATE work_orders SET status='cancelled';
    UPDATE work_orders SET status='assigned',client_visit_confirmed=1,client_window_start='2026-08-20T06:00:00Z',client_window_end='2026-08-20T14:00:00Z' WHERE id='A-1428';
    UPDATE workers SET active=0;
    UPDATE workers SET active=1,shift_status='on_shift',transport_mode='car',work_schedule_id=(SELECT work_schedule_id FROM workers WHERE id='EMP-402') WHERE id='EMP-390';
    INSERT OR IGNORE INTO worker_skills (worker_id,skill_id) SELECT 'EMP-390',skill_id FROM worker_skills WHERE worker_id='EMP-402';
    INSERT OR IGNORE INTO worker_qualifications (worker_id,qualification_id,status) SELECT 'EMP-390',qualification_id,'valid' FROM worker_qualifications WHERE worker_id='EMP-402';`);
  await host.app.json('/api/admin/settings',{method:'PUT',body:{appName:'Марш!',timezone:'Europe/Moscow',emailAlerts:true,weeklyDigest:false,optimizationEngine:'pyvrp',travelMatrixProvider:'osrm'}});
  await page.goto(host.origin);await page.getByLabel('Дата планирования').fill('2026-08-20');
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  const section=page.getByRole('region',{name:'Сообщение клиентам о переносах',exact:true});
  await section.waitFor();const publish=page.getByRole('button',{name:'Опубликовать план',exact:true});
  assert.equal(await publish.isDisabled(),true);
  assert.equal(host.app.db.prepare("SELECT assignee_worker_id FROM work_orders WHERE id='A-1428'").get().assignee_worker_id,'EMP-402');
  await section.getByRole('checkbox').check();assert.equal(await publish.isEnabled(),true);
  await page.reload();await section.waitFor();assert.equal(await section.getByRole('checkbox').isChecked(),false);
  await section.getByRole('checkbox').check();await publish.click();
  await section.getByText('Переносы согласованы при публикации',{exact:true}).waitFor();
  assert.equal(host.app.db.prepare("SELECT actor_user_id FROM audit_events WHERE entity_id='A-1428' AND action='client_notified'").get().actor_user_id,'QA-ADMIN');
});

test("UI-20 manual assignment without equipment is allowed and marked red in the plan, request and equipment report",async t=>{
  const page=await pageFor(t),f=await equipmentScenario(host.app);await f.issue([f.equipment[0].id]);const job=await f.create(1);
  await page.goto(`${host.origin}/requests?open=${job.id}`);
  const dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:/^Исполнитель/}).selectOption(f.worker.id);
  const warning=dialog.getByText(/У бригады нет оборудования: Лестница/);await warning.waitFor();
  assert.equal(await warning.evaluate(el=>getComputedStyle(el).color),'rgb(180, 35, 24)');
  await dialog.getByRole('button',{name:/Сохранить изменения/}).click();await dialog.waitFor({state:'hidden'});
  await page.goto(host.origin);await page.getByLabel('Дата планирования').fill(f.date);
  await page.getByLabel('Подразделение',{exact:true}).selectOption('ORG-001');
  const route=page.getByRole('region',{name:`Задачи исполнителя ${f.worker.name}`,exact:true});
  const planWarning=route.getByText(/У бригады нет оборудования: Лестница/);await planWarning.waitFor();
  assert.equal(await planWarning.evaluate(el=>getComputedStyle(el).color),'rgb(180, 35, 24)');
  await page.getByRole('button',{name:'Требуемое оборудование',exact:true}).click();
  await page.getByRole('dialog').getByText('Нет у бригады',{exact:true}).waitFor();
});

test("UI-21 the engineer card records the received kit and preserves it independently of future demand",async t=>{
  const page=await pageFor(t),f=await equipmentScenario(host.app);await f.create(0,true);
  await page.goto(`${host.origin}/engineers`);await page.getByRole('button',{name:`Редактировать: ${f.worker.name}`,exact:true}).click();
  const panel=page.getByRole('region',{name:'Оборудование бригады на день',exact:true});await panel.getByLabel('Тестер',{exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Тестер',{exact:true}).isChecked(),true);
  assert.equal(await panel.getByLabel('Лестница',{exact:true}).isChecked(),false);
  await panel.getByRole('button',{name:'Комплект получен, бригада выехала',exact:true}).click();
  await panel.getByText('Полученный комплект сохранён. Пересчитайте план.',{exact:true}).waitFor();
  await f.create(1,true);await page.reload();await page.getByRole('button',{name:`Редактировать: ${f.worker.name}`,exact:true}).click();
  await panel.getByLabel('Тестер',{exact:true}).waitFor();assert.equal(await panel.getByLabel('Лестница',{exact:true}).isChecked(),false);
});

test('UI-31 existing VK and HD are selected in both request entry points with the public number',async t=>{
  const page=await pageFor(t),fixture=await compositeReportScenario(host.app);
  host.app.db.prepare("UPDATE work_orders SET number='54964' WHERE id=?").run(fixture.order.id);
  let calculations=0;page.on('request',r=>{if(r.url().endsWith('/api/planning/group')&&r.method()==='POST')calculations++;});
  const verify=async()=>{
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox',{name:'Номер заявки',exact:true}).inputValue(),'54964');
    assert.equal(await dialog.getByRole('combobox',{name:'Тип ВК',exact:true}).inputValue(),fixture.category.id);
    assert.equal(await dialog.getByRole('combobox',{name:'Тип ВК',exact:true}).locator('option[value=""]').count(),0);
    for(const type of fixture.types)assert.equal(await dialog.getByRole('checkbox',{name:type.name,exact:true}).isChecked(),true);
    assert.ok(!(await dialog.innerText()).includes(fixture.order.id));
  };
  await page.goto(`${host.origin}/requests?open=${fixture.order.id}`);await verify();
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();
  await page.goto(host.origin);
  await page.getByRole('button',{name:/Показать маршрут исполнителя/}).first().click();
  assert.ok((await page.locator('.engineer-load').allTextContents()).every(text=>text==='0%'));
  await page.locator('.planning-unassigned').getByRole('button',{name:/54964/}).click();await verify();
  assert.equal(calculations,0);
});

test('UI-33 VK equipment can be added, edited and unlinked; worker car options exclude occupied vehicles',async t=>{
  const page=await pageFor(t,{width:1011});
  const category=(await host.app.json('/api/admin/work-categories',{method:'POST',body:{name:'Подключение',description:'',active:true,equipment:[]}},201)).item;
  const equipment=(await host.app.json('/api/admin/equipment',{method:'POST',body:{name:'Инструмент',unit:'шт',usage:'reusable',active:true}},201)).item;
  await page.goto(host.origin+'/admin');await page.getByRole('tab',{name:'Типы заявок',exact:true}).click();
  await page.getByRole('button',{name:'Оборудование ВК',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Добавить из справочника',{exact:true}).selectOption(equipment.id);
  await dialog.getByRole('button',{name:'Добавить в ВК',exact:true}).click();
  await dialog.getByLabel('Количество: Инструмент',{exact:true}).fill('2');
  await dialog.getByRole('button',{name:'Сохранить список оборудования',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Оборудование ВК',exact:true}).click();
  await dialog.getByRole('button',{name:'Редактировать Инструмент',exact:true}).click();
  await dialog.getByLabel('Название оборудования',{exact:true}).fill('Новый инструмент');
  await dialog.getByRole('button',{name:'Сохранить оборудование',exact:true}).click();
  await dialog.getByLabel('Количество: Новый инструмент',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Убрать из ВК: Новый инструмент',exact:true}).click();
  await dialog.getByRole('button',{name:'Сохранить список оборудования',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual((await host.app.json('/api/admin/work-categories')).items.find(c=>c.id===category.id).equipment,[]);
  const workers=(await host.app.json('/api/engineers')).items;
  host.app.db.exec("UPDATE resources SET assigned_worker_id=NULL,status='available',condition='serviceable'");
  const vehicles=(await host.app.json('/api/engineers')).vehicles;
  host.app.db.prepare('UPDATE resources SET assigned_worker_id=? WHERE id=?').run(workers[1].id,vehicles[0].id);
  host.app.db.prepare("UPDATE workers SET employee_number='12345',transport_mode='car',travel_mode='car' WHERE id=?").run(workers[0].id);
  await page.goto(host.origin+'/engineers');
  await page.getByRole('button',{name:'Редактировать: '+workers[0].name,exact:true}).click();
  assert.equal(await dialog.getByRole('textbox',{name:'Табельный номер',exact:true}).inputValue(),'12345');
  assert.equal(await dialog.getByRole('combobox',{name:'Участок',exact:true}).count(),0);
  assert.equal(await dialog.getByText('Необходимые навыки',{exact:false}).count(),0);
  const car=dialog.getByRole('combobox',{name:'Госномер',exact:true});
  assert.equal(await car.locator('option').filter({hasText:vehicles[0].plate}).count(),0);
  await car.selectOption(vehicles[1].id);
  await dialog.getByRole('button',{name:'Сохранить изменения',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal((await host.app.json('/api/engineers')).items.find(w=>w.id===workers[0].id).resourceId,vehicles[1].id);
});

test('UI-32 requests default to twenty rows and page size changes reset the page; obsolete section filter is absent',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  for(let index=0;index<45;index++)host.app.db.prepare(`INSERT INTO work_orders (id,organization_id,number,work_type_version_id,created_by_user_id,status,scheduled_start,address_snapshot,created_at,updated_at)
    VALUES (?,'ORG-001',?,'COMMON-1-V','QA-ADMIN','new','2026-08-20T10:00','Москва','2026-08-20','2026-08-20')`).run(`PAGINATION-${index}`,String(60000+index));
  await page.goto(`${host.origin}/requests`);await page.getByRole('tab',{name:'Новые',exact:true}).click();
  const size=page.getByRole('combobox',{name:'Строк на странице',exact:true});assert.equal(await size.inputValue(),'20');
  await page.locator('.request-row').nth(19).waitFor();assert.equal(await page.locator('.request-row').count(),20);
  await page.getByRole('button',{name:'Следующая страница',exact:true}).click();await page.getByText('Показано 21-40 из 46 заявок',{exact:true}).waitFor();
  await size.selectOption('50');await page.getByText('Показано 1-46 из 46 заявок',{exact:true}).waitFor();assert.equal(await page.locator('.request-row').count(),46);
  await size.selectOption('10');await page.getByText('Показано 1-10 из 46 заявок',{exact:true}).waitFor();assert.equal(await page.locator('.request-row').count(),10);
  await page.goto(`${host.origin}/engineers`);await page.getByRole('combobox',{name:'Статус',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Участок',exact:true}).count(),0);
  await page.getByRole('combobox',{name:'Статус',exact:true}).selectOption('off_shift');
  await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'Статус',exact:true}).inputValue(),'all');
});

test('UI-40 changing dates shows published routes quietly; only method changes show a recalculation notice',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  const {result}=await host.app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201);
  await host.app.json('/api/planning/group',{method:'PUT',body:{planId:result.planId,clientNotifiedApprovalIds:[]}});
  host.app.db.exec("UPDATE workers SET phone='12345',updated_at='2026-09-28T12:00:00Z' WHERE id='COMMON-1-W'");
  let calculations=0;
  page.on('request',request=>{if(request.method()==='POST' && request.url().includes('/api/planning'))calculations++;});
  await page.goto(host.origin);
  await page.getByText('Сохранённый расчёт',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Опубликовано',exact:true}).isEnabled(),false);
  assert.equal(await page.locator('.resource-notice').count(),0);
  assert.equal(await page.locator('.engineer-card').getByText(/Заявка COMMON-/).count(),result.routes.length);
  await page.getByLabel('Дата планирования').fill('2026-08-21');
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.resource-notice').count(),0);
  await page.getByLabel('Дата планирования').fill('2026-08-20');
  await page.getByText('Сохранённый расчёт',{exact:true}).waitFor();
  assert.equal(await page.locator('.resource-notice').count(),0);
  host.app.db.exec("UPDATE system_settings SET optimization_engine='ortools' WHERE id=1");
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByText('Метод расчёта расстояний или алгоритм оптимизации изменён. Пересчитайте план.',{exact:true}).waitFor();
  // The published plan still has the old method. Visiting it must load actual assignments quietly.
  for(const date of ['2026-08-21','2026-08-20']) {
    await page.getByLabel('Дата планирования').fill(date);
    await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
    assert.equal(await page.locator('.resource-notice').count(),0);
  }
  assert.equal((await host.app.json('/api/planning/group?date=2026-08-20&publishedOnly=1')).methodsChanged,true);
  assert.equal(await page.locator('.engineer-card').getByText(/Заявка COMMON-/).count(),result.routes.length);
  const refreshed=page.waitForResponse(r=>r.url().includes('/api/planning/group?date=2026-08-20&publishedOnly=1'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await refreshed;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.resource-notice').count(),0);
  await page.reload();
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.resource-notice').count(),0);
  assert.equal(await page.locator('.engineer-card').getByText(/Заявка COMMON-/).count(),result.routes.length);
  assert.equal(calculations,0);
});

test('UI-41 date changes discard proposals, focus cannot restore them, explicit calculation can',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  host.app.db.exec("UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W' WHERE id='COMMON-1-J'");
  let calculations=0;
  page.on('request',request=>{if(request.method()==='POST' && request.url().includes('/api/planning'))calculations++;});
  await page.goto(host.origin);
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await page.getByText('Черновик',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Пересчитать',exact:true}).waitFor();
  await page.locator('.engineer-card').getByText(/^Заявка COMMON-2(?: ·|$)/).waitFor();
  const original=(await host.app.json('/api/planning/group?date=2026-08-20')).result;
  for(const date of ['2026-08-21','2026-08-20']) {
    await page.getByLabel('Дата планирования').fill(date);
    await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  }
  await page.getByText('Общая работа · COMMON-2',{exact:true}).waitFor();
  assert.equal(await page.locator('.engineer-card').getByText(/^Заявка COMMON-2(?: ·|$)/).count(),0);
  assert.equal(await page.locator('.engineer-card').getByText('Заявка COMMON-1',{exact:true}).count(),1);
  assert.match(await page.locator('.stitch-metrics article').nth(1).locator('strong').innerText(),/^1\s*\/ 2$/);
  assert.equal(await page.getByRole('button',{name:'Опубликовать план',exact:true}).isEnabled(),false);
  const refreshed=page.waitForResponse(r=>r.url().includes('/api/planning/group?date=2026-08-20&publishedOnly=1'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await refreshed;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('Черновик',{exact:true}).count(),0);
  assert.equal(calculations,1);
  assert.equal((await host.app.json('/api/planning/group?date=2026-08-20')).result.planId,original.planId);
  await page.getByRole('button',{name:'Пересчитать',exact:true}).click();
  await page.getByText('Черновик',{exact:true}).waitFor();
  await page.locator('.engineer-card').getByText(/^Заявка COMMON-2(?: ·|$)/).waitFor();
  assert.equal(calculations,2);
});


test('UI-42 date navigation loads actual assigned map routes without recalculation',async t=>{
  const page=await pageFor(t);commonScenario(host.app);
  host.app.db.exec("UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W' WHERE id='COMMON-1-J'");
  let calculations=0,geometryLoads=0;
  page.on('request',request=>{
    if(request.method()==='POST' && request.url().includes('/api/planning'))calculations++;
    if(request.url().includes('/api/planning/assigned-routes?'))geometryLoads++;
  });
  await page.route('https://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')}));
  await page.goto(host.origin);
  await page.locator('.planning-map-osm .planning-map-canvas.ready').waitFor();
  const assigned=page.locator('.osm-route-label').filter({hasText:'Заявка COMMON-1'}).first();
  await assigned.waitFor();
  await page.locator('.stitch-map-legend summary').filter({hasText:'· 1'}).waitFor();
  await page.locator('.planning-map path[stroke-width="5"]').first().waitFor({state:'attached'});
  assert.equal(await page.locator('.osm-route-label').filter({hasText:'COMMON-2'}).count(),0,'new jobs are not proposed routes');
  const before=geometryLoads;
  await page.getByRole('button',{name:/Показать маршрут исполнителя/}).first().click();
  const reload=page.waitForResponse(r=>r.url().includes('/api/planning/workspace?date=2026-08-20'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await reload;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(geometryLoads,before,'brigade selection and unchanged polling do not reload geometry');
  await page.getByLabel('Дата планирования').fill('2026-08-21');
  await page.waitForFunction(()=>![...document.querySelectorAll('.osm-route-label')].some(node=>node.textContent.includes('Заявка COMMON-1')));
  await page.locator('.stitch-map-legend summary').filter({hasText:'· 0'}).waitFor();
  await page.getByRole('status').filter({hasText:'Загрузка заявок'}).waitFor({state:'hidden'});
  await page.getByLabel('Дата планирования').fill('2026-08-20');
  await assigned.waitFor();
  await page.locator('.planning-map path[stroke-width="5"]').first().waitFor({state:'attached'});
  assert.equal(calculations,0);
  assert.equal(await page.getByText('Черновик',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Опубликовать план',exact:true}).isEnabled(),false);
  assert.equal(await page.locator('.resource-notice').count(),0);
});
