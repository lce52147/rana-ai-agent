import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { __test as modelToolGuidanceTest } from "./architecture/model_tool_guidance.js";
import { getPersonaProfile } from "./persona_registry.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

const PERSONAS = ["rana", "tomori", "anon", "soyo", "taki"].map((id) => {
  const profile = getPersonaProfile(id);
  return {
    id: profile.personaId,
    name: profile.canonicalName,
    workspace: profile.workspace,
  };
});

function readContract(persona, file) {
  return readFileSync(path.join(persona.workspace, file), "utf8");
}

function readPersonaPackage(persona) {
  return JSON.parse(readContract(persona, "PERSONA.json").replace(/^\uFEFF/u, ""));
}

test("all five identity contracts bind the speaker to the workspace person", () => {
  for (const persona of PERSONAS) {
    const identity = readContract(persona, "IDENTITY.md");
    const agents = readContract(persona, "AGENTS.md");
    const soul = readContract(persona, "SOUL.md");
    const packageData = persona.id === "rana" ? null : readPersonaPackage(persona);
    const contract = `${identity}\n${agents}\n${soul}\n${JSON.stringify(packageData || {})}`;

    if (packageData) {
      assert.equal(packageData.personaId, persona.id);
      assert.equal(packageData.botId, persona.id);
      assert.equal(packageData.canonicalName, persona.name);
      assert.equal(typeof packageData.roleCore?.stopRule, "string");
      assert.ok(packageData.roleCore.stopRule.trim().length > 0);
      assert.ok(Array.isArray(packageData.roleCore.assistantLeakAvoid));
    }

    assert.match(identity, new RegExp(persona.name));
    if (persona.id === "rana") {
      assert.match(identity, /第一人稱|本人/);
    } else {
      assert.match(contract, new RegExp("personaId[\\\"']?\\s*[:=]\\s*[\\\"']?" + persona.id));
    }
    if (persona.id === "rana") {
      assert.match(identity, /你是.*本人/);
    }
    assert.match(contract, /不是(?:角色|人物)?(?:助理|資料庫|百科|旁白|客服)|not (?:an )?(?:assistant|database|character database|encyclopedia)/i);
  }
});

test("persona stop rules structurally close generic service continuation", () => {
  for (const persona of PERSONAS) {
    const agents = readContract(persona, "AGENTS.md");
    const soul = readContract(persona, "SOUL.md");
    const contract = `${agents}\n${soul}`;
    const packageData = persona.id === "rana" ? null : readPersonaPackage(persona);
    const stopRule = packageData?.roleCore?.stopRule || "";
    const leakAvoid = packageData?.roleCore?.assistantLeakAvoid || [];

    assert.match(contract, /(?:普通問題完成後停止|普通.*直接回答|一般.*直接(?:回答|反應)|普通.*直接回答|沒有第二個目的就停)|ordinary (?:conversation|chat|replies?)/i);
    assert.match(contract, /(?:直接回答|直接反應|先說當下|先以.*反應|先判斷|先對.*反應|先注意)|(?:answer|react) directly/i);
    assert.ok(
      /(?:停止|普通回答完成後停|不.*(?:客服|服務|重問|第二個問題)|不必維持客服|不要.*固定)/u.test(stopRule)
        || /(?:不要|不得|禁止|never|do not).*(?:追加|邀請|客服|服務|延續聊天|assistant endings?|service)/i.test(contract),
      `${persona.id} lacks an active stop rule`,
    );
    if (packageData) {
      assert.ok(leakAvoid.length > 0, `${persona.id} lacks assistant-leak controls`);
    }
  }

  const anon = readPersonaPackage(PERSONAS[2]);
  assert.match(`${readContract(PERSONAS[2], "AGENTS.md")}\n${readContract(PERSONAS[2], "SOUL.md")}`, /社交|主動|initiative/i);
  assert.match(anon.roleCore.stopRule, /社交目的/);

  const soyo = readPersonaPackage(PERSONAS[3]);
  assert.match(`${readContract(PERSONAS[3], "AGENTS.md")}\n${readContract(PERSONAS[3], "SOUL.md")}`, /正式|禮貌|語域|場合|formal|register/i);
  assert.match(soyo.roleCore.stopRule, /正式場合|客服式禮貌/);
});

test("ordinary conversation receives no model-tool guidance injection", () => {
  const ordinaryPrompts = [
    "早安，今天風很大。",
    "你是誰？",
    "我剛剛想到一件好笑的事。",
    "@Rana 喵",
  ];
  for (const prompt of ordinaryPrompts) {
    assert.equal(modelToolGuidanceTest.buildModelToolGuidance(prompt), undefined, prompt);
  }

  const groundedToolPrompts = ["@Rana 播放春日影", "幫我查 NVDA 股價"];
  for (const prompt of groundedToolPrompts) {
    assert.equal(typeof modelToolGuidanceTest.buildModelToolGuidance(prompt), "string", prompt);
  }
});

test("runtime source has structural boundaries, not historical reply or relationship maps", () => {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const source = readdirSync(runtimeDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(path.join(runtimeDir, file), "utf8"))
    .join("\n");

  assert.doesNotMatch(source, /(?:relationship|persona|assistant)[A-Za-z]*AnswerMap/i);
  assert.doesNotMatch(source, /(?:mustMention|requiredAddress|supportMatrix|relationshipMatrix|deterministicPersonaTemplate)/i);
  assert.doesNotMatch(source, /(?:generic|assistant|relationship|persona)[A-Za-z]*(?:Phrase|Reply|Template|Map|List)\b/i);
  assert.match(source, /expectedToolForText/);
  assert.match(source, /personaId/);
});
