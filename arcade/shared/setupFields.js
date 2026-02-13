// /arcade/shared/setupFields.js
// Single source of truth for Arcade setup-field markup.
// Renders identical setup fields into both /arcade/ (lobby) and /arcade/play/ (in-game).

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
}

function csv(values) {
  return String(values || "")
    .split(",")
    .map((x) => String(x).trim())
    .filter(Boolean);
}

function optionList(values, selectedValue) {
  const sel = selectedValue != null ? String(selectedValue) : null;
  return values
    .map((v) => {
      const s = sel !== null && String(v) === sel ? " selected" : "";
      return `<option value="${String(v)}"${s}>${String(v)}</option>`;
    })
    .join("\n");
}

function tplStepper(targetId, valuesCsv) {
  return `
    <div class="setupStepper" data-setup-stepper data-target="${targetId}" data-values="${valuesCsv}">
      <button type="button" class="setupStepBtn" data-step="dec" aria-label="Decrease">&lt;</button>
      <div class="setupStepValue" data-stepper-value>—</div>
      <button type="button" class="setupStepBtn" data-step="inc" aria-label="Increase">&gt;</button>
    </div>
  `.trim();
}

function tplHiddenSelect(targetId, values, selectedValue) {
  return `
    <select id="${targetId}" aria-hidden="true" tabindex="-1" class="setupHiddenControl">
      ${optionList(values, selectedValue)}
    </select>
  `.trim();
}

function tplHiddenNumber(targetId, min, max, value) {
  return `
    <input id="${targetId}" aria-hidden="true" tabindex="-1" class="setupHiddenControl" type="number" min="${min}" max="${max}" value="${value}" />
  `.trim();
}

function tplToggleRow(targetId) {
  return `
    <div class="setupBtnRow arcade" data-setup-toggle data-target="${targetId}" style="margin-top:12px;">
      <button type="button" class="setupBtn" data-value="on">On</button>
      <button type="button" class="setupBtn" data-value="off">Off</button>
    </div>
    <input type="checkbox" id="${targetId}" class="setupHiddenControl" aria-hidden="true" tabindex="-1" checked />
  `.trim();
}

function tplGroupRow(targetId, buttons, extraClass = "") {
  const cls = ["setupBtnRow arcade", extraClass].filter(Boolean).join(" ");
  const btnHtml = buttons
    .map((b) => `<button type="button" class="setupBtn" data-value="${b.value}">${b.label}</button>`)
    .join("\n");
  return `
    <div class="${cls}" data-setup-group data-target="${targetId}">
      ${btnHtml}
    </div>
  `.trim();
}

function tplStarterRow(targetId, defaultValue = "p1") {
  const buttons = [
    { value: "p1", label: "Player 1" },
    { value: "p2", label: "Player 2" },
    { value: "random", label: "Random" },
  ];
  return `
    <label class="setupLabel" for="${targetId}">Starter</label>
    ${tplGroupRow(targetId, buttons, "threegrid")}
    <select id="${targetId}" aria-hidden="true" tabindex="-1" class="setupHiddenControl">
      ${buttons.map(b => `<option value="${b.value}"${b.value===defaultValue?" selected":""}>${b.label}</option>`).join("\n")}
    </select>
  `.trim();
}

function tplSuddenDeathRow(targetId, label = "Sudden death if draw") {
  return `
    <div class="setupLabel">${label}</div>
    ${tplToggleRow(targetId)}
  `.trim();
}

function tplBullFields({ online }) {
  const values = Array.from({ length: 50 }, (_, i) => String(i + 1));
  const valuesCsv = values.join(",");
  return `
  <div class="arcadesetupblock">
    ${tplStarterRow(online ? "bullOnlineStarterSelect" : "bullLocalStarterSelect")}
  </div>
  <div class="arcadesetupblock">
    <label class="setupLabel" for="${online ? "arcadeOnlineVisitsInput" : "arcadeLocalVisitsInput"}">Visits per player</label>
    ${tplStepper(online ? "arcadeOnlineVisitsInput" : "arcadeLocalVisitsInput", valuesCsv)}
    ${tplHiddenNumber(online ? "arcadeOnlineVisitsInput" : "arcadeLocalVisitsInput", 1, 50, 10)}
  </div>
    <div class="setupblock">
    <div class="setupLabel">Sudden death if draw</div>
    ${tplToggleRow(online ? "arcadeOnlineSuddenDeathChk" : "arcadeLocalSuddenDeathChk").replace(" checked", " checked")}
    </div>
    </div>
    ${
      online
        ? `
    <div class="setupLabel">Mutual control</div>
    ${tplToggleRow("arcadeOnlineMutualChk").replace(" checked", " checked")}
    `.trim()
        : ""
    }
  `.trim();
}

function tplHighScoreFields({ online }) {
  const values = ["5", "10", "15", "20"];
  const valuesCsv = values.join(",");
  const roundsId = online ? "hsOnlineRoundsSelect" : "hsLocalRoundsSelect";
  const starterId = online ? "hsOnlineStarterSelect" : "hsLocalStarterSelect";
  const sdId = online ? "hsOnlineSuddenDeathChk" : "hsLocalSuddenDeathChk";
  return `
    <div class="arcadetwogrid">
      <div class="arcadesetupblock">
        ${tplStarterRow(starterId)}
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${roundsId}">Rounds</label>
        ${tplStepper(roundsId, valuesCsv)}
        ${tplHiddenSelect(roundsId, values, "10")}
      </div>
    </div>
    <div class="setupblock" style="margin-top:12px;">
      ${tplSuddenDeathRow(sdId)}
    </div>
    ${
      online
        ? `
      <div class="setupLabel" style="margin-top:12px;">Mutual control</div>
      ${tplToggleRow("hsOnlineMutualChk")}
    `.trim()
        : ""
    }
  `.trim();
}

function tplRoundsFields({ online }) {
  const values = ["5", "10", "15", "20"];
  const valuesCsv = values.join(",");
  const firstToId = online ? "roundsOnlineFirstToSelect" : "roundsLocalFirstToSelect";
  const starterId = online ? "roundsOnlineStarterSelect" : "roundsLocalStarterSelect";
  const sdId = online ? "roundsOnlineSuddenDeathChk" : "roundsLocalSuddenDeathChk";
  return `
    <div class="arcadetwogrid">
      <div class="arcadesetupblock">
        ${tplStarterRow(starterId)}
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${firstToId}">First to</label>
        ${tplStepper(firstToId, valuesCsv)}
        ${tplHiddenSelect(firstToId, values, "5")}
      </div>
    </div>
    <div class="setupblock" style="margin-top:12px;">
      ${tplSuddenDeathRow(sdId)}
    </div>
    ${
      online
        ? `
      <div class="setupLabel" style="margin-top:12px;">Mutual control</div>
      ${tplToggleRow("roundsOnlineMutualChk")}
    `.trim()
        : ""
    }
  `.trim();
}

function tplRaceFields({ online }) {
  const values = ["100","200","300","400","500","600","700","800","900","1000"];
  const valuesCsv = values.join(",");
  const targetId = online ? "raceOnlineTargetSelect" : "raceLocalTargetSelect";
  const starterId = online ? "raceOnlineStarterSelect" : "raceLocalStarterSelect";
  const sdId = online ? "raceOnlineSuddenDeathChk" : "raceLocalSuddenDeathChk";
  return `
    <div class="arcadetwogrid">
      <div class="arcadesetupblock">
        ${tplStarterRow(starterId)}
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${targetId}">Target</label>
        ${tplStepper(targetId, valuesCsv)}
        ${tplHiddenSelect(targetId, values, "300")}
      </div>
    </div>
    <div class="setupblock" style="margin-top:12px;">
      ${tplSuddenDeathRow(sdId)}
    </div>
    ${
      online
        ? `
      <div class="setupLabel" style="margin-top:12px;">Mutual control</div>
      ${tplToggleRow("raceOnlineMutualChk")}
    `.trim()
        : ""
    }
  `.trim();
}

function tplAtcFields({ online }) {
  const startId = online ? "atcOnlineStartOnSelect" : "atcLocalStartOnSelect";
  const multId = online ? "atcOnlineMultipliersChk" : "atcLocalMultipliersChk";
  const exitId = online ? "atcOnlineExitTypeSelect" : "atcLocalExitTypeSelect";
  const punId = online ? "atcOnlinePunishmentSelect" : "atcLocalPunishmentSelect";
  const starterId = online ? "atcOnlineStarterSelect" : "atcLocalStarterSelect";
  const sdId = online ? "atcOnlineSuddenDeathChk" : "atcLocalSuddenDeathChk";

  const startValues = ["1", "20"];
  const exitOptions = [
    { value: "bull", label: "Bull (Red only)" },
    { value: "outer_and_bull", label: "Outer Bull AND Bull" },
    { value: "outer_or_bull", label: "Outer Bull OR Bull" },
  ];
  const punOptions = [
    { value: "0", label: "None" },
    { value: "1", label: "Regress 1" },
    { value: "2", label: "Regress 2" },
    { value: "3", label: "Regress 3" },
  ];

  return `
    <div class="atcsetupgrid">
      <div class="arcadesetupblock">
        ${tplStarterRow(starterId)}
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${startId}">Start on</label>
        ${tplStepper(startId, startValues.join(","))}
        ${tplHiddenSelect(startId, startValues, "1")}
      </div>
      <div class="arcadesetupblock">
        <div class="setupLabel" style="margin-top:12px;">Double / Treble multipliers</div>
        ${tplToggleRow(multId)}
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${exitId}" style="margin-top:12px;">Exit type</label>
        ${tplGroupRow(exitId, exitOptions)}
        <select id="${exitId}" aria-hidden="true" tabindex="-1" class="setupHiddenControl">
          ${exitOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join("\n")}
        </select>
      </div>
      <div class="arcadesetupblock">
        <label class="setupLabel" for="${punId}" style="margin-top:12px;">Punishment</label>
        ${tplGroupRow(punId, punOptions, "twogrid")}
        <select id="${punId}" aria-hidden="true" tabindex="-1" class="setupHiddenControl">
          ${punOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join("\n")}
        </select>
      </div>
      <div class="arcadesetupblock" style="margin-top:12px;">
        ${tplSuddenDeathRow(sdId)}
      </div>
    </div>
    ${
      online
        ? `
      <div class="setupLabel" style="margin-top:12px;">Mutual control</div>
      ${tplToggleRow("atcOnlineMutualChk")}
    `.trim()
        : ""
    }
  `.trim();
}

export function renderArcadeSetupFields() {
  // /arcade/ roots
  setHTML("bullSetupFieldsLocalRoot", tplBullFields({ online: false }));
  setHTML("bullSetupFieldsOnlineRoot", tplBullFields({ online: true }));
  setHTML("atcSetupFieldsLocalRoot", tplAtcFields({ online: false }));
  setHTML("atcSetupFieldsOnlineRoot", tplAtcFields({ online: true }));
  setHTML("hsSetupFieldsLocalRoot", tplHighScoreFields({ online: false }));
  setHTML("hsSetupFieldsOnlineRoot", tplHighScoreFields({ online: true }));
  setHTML("roundsSetupFieldsLocalRoot", tplRoundsFields({ online: false }));
  setHTML("roundsSetupFieldsOnlineRoot", tplRoundsFields({ online: true }));
  setHTML("raceSetupFieldsLocalRoot", tplRaceFields({ online: false }));
  setHTML("raceSetupFieldsOnlineRoot", tplRaceFields({ online: true }));

  // /arcade/play/ containers
  setHTML("bullSetupFieldsLocal", tplBullFields({ online: false }));
  setHTML("bullSetupFieldsOnline", tplBullFields({ online: true }));
  setHTML("atcSetupFieldsLocal", tplAtcFields({ online: false }));
  setHTML("atcSetupFieldsOnline", tplAtcFields({ online: true }));
  setHTML("hsSetupFieldsLocal", tplHighScoreFields({ online: false }));
  setHTML("hsSetupFieldsOnline", tplHighScoreFields({ online: true }));
  setHTML("roundsSetupFieldsLocal", tplRoundsFields({ online: false }));
  setHTML("roundsSetupFieldsOnline", tplRoundsFields({ online: true }));
  setHTML("raceSetupFieldsLocal", tplRaceFields({ online: false }));
  setHTML("raceSetupFieldsOnline", tplRaceFields({ online: true }));
}
