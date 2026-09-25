# Priority

Priority is an issue field that the organization defines. It is not a label. `gh issue` has
no flag for it, so use GraphQL.

## Rubric

Choose the lowest level that fits.

| Level | Meaning | Examples |
| --- | --- | --- |
| Urgent | Broken now with no workaround, or it stops other work. Do it next. | Red CI on the default branch. A plugin does not load. A security exposure. |
| High | It blocks planned work, or a usual path is wrong and the workaround costs much effort. | It blocks an open issue in an active milestone. A skill gives a wrong result in normal use. |
| Medium | The default. A real defect or improvement on a usual path. It has a workaround, and no work waits on it. | A flag that is not there. Output that is not clear. A slow command. |
| Low | An edge case that is not likely to occur, polish, or a follow-up that is only an idea. | A failure on an unusual repository layout. A word change. "It could also support X". |

- If you cannot choose between two levels, choose the lower one.
- An issue that blocks an open issue is never Low.

## Read the field

```bash
gh api graphql -F owner='{owner}' -F repo='{repo}' -f query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issueFields(first:50){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}' --jq '[.data.repository.issueFields.nodes[]? | select(.name == "Priority")]'
```

An empty list means that the owner has no Priority field. A repository that a user owns
always gives an empty list. Then put the level in the report only. Do not do "Set it" or
"Read it back", and do not use a label or the body instead.

Find the option by its name. Do not keep an ID from an earlier run. If the option names are
not the four levels above, show how the levels map to them, and ask.

## Set it

```bash
gh issue view <n> --json id --jq .id
gh api graphql -f issue=<issue id> -f field=<field id> -f option=<option id> -f query='mutation($issue:ID!,$field:ID!,$option:ID!){setIssueFieldValue(input:{issueId:$issue,issueFields:[{fieldId:$field,singleSelectOptionId:$option}]}){issue{number}}}'
```

## Read it back

```bash
gh api graphql -F owner='{owner}' -F repo='{repo}' -F n=<n> -f query='query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){issueFieldValues(first:20){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}}}}' --jq '[.data.repository.issue.issueFieldValues.nodes[] | select(.field.name == "Priority") | .name]'
```

An empty list means that the issue has no priority. Report the read-back value.
