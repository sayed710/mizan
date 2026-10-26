#!/bin/bash
# For each module that wins a model-key collision, move its spread to the front (so it loses) and count failing tests.
W=evidence/work-arch
O=evidence/index.js.orig
cd $W
for m in ecommerceModels warehouseModels quotePlusModels billControlModels workorderModels expensePlusModels recruitPlusModels eventsPlusModels subscriptionPlusModels posPlusModels websitePlusModels signPlusModels documentsPlusModels planningPlusModels maintPlusModels qualityPlusModels fleetPlusModels attendancePlusModels appraisalPlusModels surveyModels lunchModels approvalsPlusModels repairPlusModels fsmModels frontdeskPlusModels elearningModels skillsPlusModels analyticPlusModels; do
  cp $O src/models/index.js
  python3 -I - "$m" <<'PY'
import re, sys
m=sys.argv[1]; p='src/models/index.js'; s=open(p).read()
line=re.search(r'export const models = withCompany\(\{[\s\S]*?\}\);', s).group(0)
new=line.replace('...'+m+', ','',1) if ('...'+m+', ') in line else line.replace(', ...'+m+' ','',1)
new=new.replace('withCompany({ ','withCompany({ ...'+m+', ',1)
assert new!=line and new.count(m)==1
open(p,'w').write(s.replace(line,new))
PY
  res=$(timeout 300 node --test "src/**/*.test.js" "server/**/*.test.js" 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
  echo "$m moved-first: $res"
done
cp $O src/models/index.js
cmp src/models/index.js /home/claude/mizan/src/models/index.js && echo restored
