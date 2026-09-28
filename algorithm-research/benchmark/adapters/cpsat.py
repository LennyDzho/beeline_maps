from .linear_reference import solve as _solve


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    return _solve(problem, policy, time_limit, seed, initial_solution, fixed_activities, engine="cpsat")
