# Restrict v1 to owner-approved private repositories

Version one will execute only in allowlisted private repositories, and only a Work Issue approved by an allowlisted owner with a valid Approval Digest may enter the Repository Queue. Fork pull requests and other externally supplied events cannot authorize execution; this limits early adoption and collaboration in exchange for protecting the dedicated Mac mini runner from untrusted repository code.
