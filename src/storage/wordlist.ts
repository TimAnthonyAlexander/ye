const ADJECTIVES: readonly string[] = [
  "amber", "ancient", "azure", "bold", "brave", "brisk", "calm", "clever", "crimson",
  "crisp", "dapper", "deft", "eager", "earnest", "fierce", "frosty", "gentle", "golden",
  "graceful", "happy", "humble", "icy", "jolly", "keen", "kind", "lively", "lucky",
  "merry", "mighty", "nimble", "noble", "olive", "patient", "plucky", "polite", "proud",
  "quick", "quiet", "radiant", "rapid", "ready", "regal", "ruby", "rustic", "scarlet",
  "sharp", "silent", "silver", "sly", "smooth", "spry", "steady", "stout", "sturdy",
  "sunny", "swift", "tame", "tender", "tidy", "tireless", "vivid", "warm", "wise", "zesty",
];

const NOUNS: readonly string[] = [
  "anchor", "arrow", "badger", "beacon", "branch", "cedar", "comet", "compass", "cove",
  "creek", "dawn", "delta", "dune", "ember", "falcon", "fern", "forge", "fox", "garden",
  "glade", "harbor", "hawk", "heron", "ibex", "jaguar", "kestrel", "lantern", "lark",
  "ledge", "lichen", "lighthouse", "lily", "lion", "lynx", "marsh", "meadow", "mesa",
  "moose", "moss", "mountain", "nest", "oak", "orbit", "otter", "owl", "panther",
  "petal", "pine", "puffin", "quail", "quartz", "raven", "ridge", "river", "robin",
  "salmon", "seal", "spruce", "stag", "stream", "sunrise", "thicket", "thunder", "tide",
  "torch", "tundra", "valley", "violet", "wave", "willow", "wren",
];

const pickRandom = <T>(arr: readonly T[]): T => {
  if (arr.length === 0) throw new Error("wordlist empty");
  const i = Math.floor(Math.random() * arr.length);
  return arr[i] as T;
};

export const randomPlanName = (): string => `${pickRandom(ADJECTIVES)}-${pickRandom(NOUNS)}`;
