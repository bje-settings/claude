# Milestone

List the open milestones:

```bash
gh api repos/{owner}/{repo}/milestones -X GET -f state=open -f per_page=100 --paginate --jq '.[] | {title, description, open_issues}'
```

## Suggest

Propose an open milestone only when its title and description fit the area and the type of
the issue. If none fits, propose no milestone. Do not create a milestone for one issue.

## Create for a batch

Two or more issues with one shared done condition are a milestone. Propose a title, and use
the done condition as the description. Create it before the issues, so each issue gets it on
creation:

```bash
gh api repos/{owner}/{repo}/milestones -f title="<title>" -f description="<done condition>" --jq .title
```
