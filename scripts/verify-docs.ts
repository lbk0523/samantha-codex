import { readdir, readFile } from "node:fs/promises";

const DOCS = [
  "README.md",
  "readme-kr.md",
  ...(await readdir("docs")).filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`),
];
const LOCAL_ABSOLUTE_PATH = /(?:\/Users\/|\/home\/|\/private\/|\/Volumes\/|[A-Za-z]:\\)/;

for (const path of DOCS) {
  const text = await readFile(path, "utf8");
  if (LOCAL_ABSOLUTE_PATH.test(text)) {
    console.error(`${path} contains a local absolute path.`);
    process.exit(1);
  }
}

const readme = await readFile("README.md", "utf8");
if (!readme.includes("[readme-kr.md](readme-kr.md)")) {
  console.error("README.md must link to readme-kr.md.");
  process.exit(1);
}

const koreanReadme = await readFile("readme-kr.md", "utf8");
if (!koreanReadme.includes("[README.md](README.md)")) {
  console.error("readme-kr.md must link back to README.md.");
  process.exit(1);
}
