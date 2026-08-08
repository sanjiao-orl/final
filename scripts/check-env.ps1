[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
foreach ($n in @('LLM_BASE_URL','LLM_API_KEY','LLM_MODEL','LLM_MODEL_CHEAP')) {
  $u=[Environment]::GetEnvironmentVariable($n,'User')
  $m=[Environment]::GetEnvironmentVariable($n,'Machine')
  $v = if ($u) { $u } else { $m }
  if ($v) {
    if ($n -like '*KEY*') { "$n = <set,len=$($v.Length)>" } else { "$n = $v" }
  } else { "$n = <missing>" }
}
