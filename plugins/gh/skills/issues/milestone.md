# Milestone

List the open milestones:

```bash
gh api repos/{owner}/{repo}/milestones -X GET -f state=open -f per_page=100 --paginate --jq '.[] | {title, description, open_issues}'
```

## Choose

Choose an open milestone only when its title and description fit the area and the type of
the issue. If none fits, set no milestone. Do not create a milestone for one issue.

## Create for a batch

Do this only when no open milestone fits a batch. Never create a milestone that the caller
named. Two or more issues with one shared done condition are a milestone. Choose a title,
and use the done condition as the description:

```bash
gh api repos/{owner}/{repo}/milestones -f title="<title>" -f description="<done condition>" --jq .title
```
