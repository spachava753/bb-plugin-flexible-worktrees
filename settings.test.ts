import { describe, expect, it } from "vitest";
import { DEFAULT_PATH_TEMPLATE, pathTemplateSchema, projectOverridesSettingSchema, templateSchema } from "./inputs";
import { projectTemplate, remoteIdentity } from "./settings";
import { repoOf } from "./worktree/github";

const defaults = { pathTemplate: "{checkoutParent}/{repo}.{branch}", projectOverrides: "{}" };

describe("project destination templates", () => {
  it.each([
    ["https://github.com/team/repo.git", "github.com/team/repo"],
    ["ssh://git@GITHUB.COM/team/repo.git/", "github.com/team/repo"],
    ["git@github.com:team/repo.git", "github.com/team/repo"],
    ["github.com/team/repo", "github.com/team/repo"],
    ["https://example.com/group/subgroup/repo.git", "example.com/group/subgroup/repo"],
    ["/local/repo.git", null], ["file:///local/repo.git", null], [null, null],
  ])("normalizes %s without contacting Git", (remote, expected) => {
    expect(remoteIdentity(remote)).toBe(expected);
  });

  it("shares that normalization with gh repository identities, which need exactly owner/repo", () => {
    expect(repoOf("ssh://git@GITHUB.COM/team/repo.git/")).toBe("github.com/team/repo");
    expect(repoOf("https://example.com/group/subgroup/repo.git")).toBeUndefined();
  });

  it("chooses project ID over exact remote, then exact remote over wildcard", () => {
    const settings = { ...defaults, projectOverrides: JSON.stringify({
      "github.com/*": "~/all/{repo}/{pathKey}",
      "github.com/team/*": "~/team/{repo}.{branch}",
      "https://github.com/team/repo.git": "~/exact/{branch}",
      "proj_one": "~/project/{branch}",
    }) };
    expect(projectTemplate(settings, "proj_one", "git@github.com:team/repo.git")).toBe("~/project/{branch}");
    expect(projectTemplate(settings, "proj_two", "git@github.com:team/repo.git")).toBe("~/exact/{branch}");
    expect(projectTemplate(settings, "proj_two", "https://github.com/team/another.git")).toBe("~/team/{repo}.{branch}");
    expect(projectTemplate(settings, "proj_two", "https://github.com/other/repo.git")).toBe("~/all/{repo}/{pathKey}");
    expect(projectTemplate(settings, "proj_two", null)).toBe(defaults.pathTemplate);
  });

  it("keeps matches literal except for * and uses the built-in default for empty project templates", () => {
    const settings = { ...defaults, projectOverrides: JSON.stringify({ "github.com/team/repo": "", "example.com/team/repo": "~/exact/{branch}" }) };
    expect(projectTemplate(settings, "other", "https://github.com/team/repo.git")).toBe(DEFAULT_PATH_TEMPLATE);
    expect(projectTemplate(settings, "other", "https://exampleXcom/team/repo.git")).toBe(defaults.pathTemplate);
  });

  it.each([undefined, "", "   "])("uses a single default path template when unset or blank: %s", pathTemplate => {
    expect(pathTemplateSchema.parse(pathTemplate)).toBe("~/worktrees/{pathKey}");
  });

  it("uses a deterministic tie-break regardless of JSON entry order", () => {
    const entries = [["github.com/team/*", "~/one/{branch}"], ["github.com/*/repo", "~/two/{branch}"]];
    const pick = (rows: string[][]) => projectTemplate({ ...defaults, projectOverrides: JSON.stringify(Object.fromEntries(rows)) }, "other", "https://github.com/team/repo.git");
    expect(pick(entries)).toBe(pick([...entries].reverse()));
  });

  it.each(["not json", "[]", '{"proj_one":42}', '{"proj_one":"{unknown}"}', '{"proj_one":"{{ repo }}"}'])("rejects invalid override settings: %s", value => {
    expect(projectOverridesSettingSchema.safeParse(value).success).toBe(false);
  });
  it("validates tokens before expansion, not characters inside checkout names", () => {
    expect(templateSchema.safeParse("{repoPath}/../{repo}.{branch}-{pathKey}").success).toBe(true);
    expect(templateSchema.safeParse("{repoPath}/bad\nfolder").success).toBe(false);
  });
});
