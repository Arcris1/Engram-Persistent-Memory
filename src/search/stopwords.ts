/**
 * The NLTK English stopword list (179 words), embedded verbatim so engram has no runtime dependency
 * on `nltk`/`nltk_data`. Source: `nltk.corpus.stopwords.words('english')`
 * (https://www.nltk.org/nltk_data/, corpora/stopwords, 'english' file) -- the list shipped by NLTK
 * >= 3.x, which includes the split-contraction forms (`don`, `t`, `ll`, `re`, `ve`, ...) alongside the
 * un-split ones (`don't`, `that'll`, ...), since a tokenizer that drops apostrophes (ours does, see
 * `src/search/gate.ts`) produces the split forms and still needs them filtered.
 *
 * Used only by the D40 pre-registered retrieval-quality gates (`src/search/gate.ts`); frozen exactly
 * as pre-registered in DECISIONS.md's D40 entry -- do not edit this list.
 */
export const NLTK_STOPWORDS: ReadonlySet<string> = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', "you're", "you've", "you'll",
  "you'd", 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', "she's",
  'her', 'hers', 'herself', 'it', "it's", 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', "that'll", 'these', 'those', 'am',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does',
  'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', "don't", 'should',
  "should've", 'now', 'd', 'll', 'm', 'o', 're', 've', 'y', 'ain', 'aren', "aren't", 'couldn',
  "couldn't", 'didn', "didn't", 'doesn', "doesn't", 'hadn', "hadn't", 'hasn', "hasn't", 'haven',
  "haven't", 'isn', "isn't", 'ma', 'mightn', "mightn't", 'mustn', "mustn't", 'needn', "needn't",
  'shan', "shan't", 'shouldn', "shouldn't", 'wasn', "wasn't", 'weren', "weren't", 'won', "won't",
  'wouldn', "wouldn't",
]);
