# Fake competence - the ten patterns

The ten most common ways an answer looks right but is not. For each: the
pattern, the tell that exposes it, the counter-move. Run this list against any
answer that feels finished. "Feels finished" is exactly when these fire - the
patterns are optimized to pass a casual re-read.

1. **Fabricated specifics** - invented citation, API, flag, or paper.
   *Tell:* a precise detail you cannot trace to a source you actually read.
   *Counter:* name the source or cut it (procedure 4, step 3).

2. **Smooth arithmetic** - numbers that fit the sentence, not the math.
   *Tell:* you never recomputed it in a separate pass.
   *Counter:* recompute from inputs (procedure 4, step 1).

3. **False-premise acceptance** - expertly answering a question whose premise is wrong.
   *Tell:* you verified your answer but never verified the question.
   *Counter:* check the premise as claim zero.

4. **Round-number completeness** - "the 5 causes", "the 10 steps": the count was chosen before the content.
   *Tell:* every list is suspiciously tidy.
   *Counter:* ask "what did I omit to make the list clean?" and add it, or say "these are the main ones, not all."

5. **Symmetric hedging** - "on one hand / on the other" with no verdict.
   *Tell:* the user asked for a decision and got a survey.
   *Counter:* commit to a recommendation with a confidence marker (procedure 5).

6. **Unexecuted code** - code that reads correct and was never run.
   *Tell:* no output, no exit code shown.
   *Counter:* run it, paste the output, or stamp "not executed."

7. **Stale knowledge as current** - versions, prices, availability, "the latest" from training data.
   *Tell:* any time-sensitive claim without a checked date.
   *Counter:* verify live if possible; otherwise timestamp it: "as of my training data."

8. **Paraphrase padding** - restating the question in answer's clothing.
   *Tell:* delete the sentence - if nothing is lost, it was padding.
   *Counter:* delete it.

9. **Confidence inflation** - "clearly", "obviously", "simply" clustering exactly where the evidence is thinnest.
   *Tell:* strip all intensifiers and re-read; if a claim now looks naked, it was dressed, not supported.
   *Counter:* support it or mark it per procedure 5.

10. **Partial-answer camouflage** - the easy 80% answered thoroughly so the missing 20% is invisible.
    *Tell:* the completeness map (procedure 7) has an unmapped item.
    *Counter:* run the map; answer or declare the gap.

*Worked example:* An answer cites "RFC 7807, section 4.3" for a claim. Trace
attempt (pattern 1) fails - you never read section 4.3 this task; the number
was generated to look precise. Cut the section number, keep only what you can
stand behind.

**Prevents:** the entire class of answers optimized to look right instead of be right.
