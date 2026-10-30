'use strict';

// v3.3.36 -- THE ORDER OF PUBLISHED STORIES, IN ONE PLACE (Ian, 2026-10-29: "I published them out of order. And need to
// get them in order... Could we drag them around on the Published Stories Page in My Stuff?").
//
// The Library shows one row per pen name. Inside a row an author's stories are grouped by campaign, and the author
// sets both orders on My Stuff > Published Stories by dragging: the campaign groups (public_stories.camp_pos, the same
// value on every story of the group) and the stories inside each group (story_pos). The row reads left to right in
// that order. Rows themselves stay where they were: the row whose newest story is newest comes first, so nobody can
// use this to move ahead of other authors.
//
// Not yet ordered (NULL): a campaign group nobody has placed comes first in its row, newest group first (a new story
// in a new campaign shows up at the front, as before); a story nobody has placed comes last in its group, oldest
// first (a new Book IV lands after Book III). The group's position is the largest camp_pos among its stories, so a
// story moved into a group that already has a place joins it.
//
// Both the Library (routes/public.js /stories) and My Stuff (routes/pdf.js /my-stories) sort with these strings, so
// the two lists cannot disagree. The window columns go in the SELECT list of a query FROM public_stories alone (they
// name its columns unqualified); wrap() then sorts the result.
const AUTHOR_KEY = "lower(btrim(coalesce(author_name, '')))";
const WINDOW_COLS =
  'max(id) OVER (PARTITION BY ' + AUTHOR_KEY + ') AS o_author, ' +
  'max(camp_pos) OVER (PARTITION BY user_id, ' + AUTHOR_KEY + ', campaign_id) AS o_camp, ' +
  'max(id) OVER (PARTITION BY user_id, ' + AUTHOR_KEY + ', campaign_id) AS o_campnew, ' +
  AUTHOR_KEY + ' AS o_key, user_id AS o_user, story_pos AS o_spos';
const ORDER_IN_ROW = 'o_user, o_camp ASC NULLS FIRST, o_campnew DESC, o_spos ASC NULLS LAST, id ASC';

function wrap(innerSql, rowOrder) {
  return 'SELECT * FROM (' + innerSql + ') o ORDER BY ' + rowOrder + ', ' + ORDER_IN_ROW;
}

module.exports = { AUTHOR_KEY: AUTHOR_KEY, WINDOW_COLS: WINDOW_COLS, ORDER_IN_ROW: ORDER_IN_ROW, wrap: wrap };
